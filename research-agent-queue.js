import {z} from 'zod';
import {stableResearchTaskId} from './research-agent-ingest.js';

const uuid = z.uuid();
const domain = z.string()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u);
const source = z.enum([
  'website',
  'apollo',
  'companiesHouse',
  'procurement',
]);
const allSources = [
  'website',
  'apollo',
  'companiesHouse',
  'procurement',
];
const availableSources = z.array(source)
  .min(1)
  .max(4)
  .refine(values => new Set(values).size === values.length, {
    message: 'Available worker sources must be unique',
  })
  .refine(values => values.includes('website'), {
    message: 'Every research worker must support official websites',
  });
const workerId = z.string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9._-]+$/u);
const DEFAULT_CLAIM_PAGE_SIZE = 10;
const MAX_CLAIM_PAGE_SIZE = 100;

const storedCompany = z.object({
  companyId: z.string().trim().min(1).max(240),
  domain,
  apolloSearchDomain: domain.optional(),
}).strict();

const storedConfiguration = z.object({
  requestedSources: z.array(source).min(1).max(4),
  apolloMaxPeople: z.number().int().min(1).max(25),
  procurementDays: z.number().int().min(0).max(365),
  companies: z.array(storedCompany).min(1).max(25),
  requestedBy: uuid,
  requestVersion: z.literal(1),
}).strict().superRefine((configuration, context) => {
  if (!configuration.requestedSources.includes('website')) {
    context.addIssue({
      code: 'custom',
      path: ['requestedSources'],
      message: 'Official website research must remain enabled',
    });
  }
  if (new Set(configuration.requestedSources).size !== configuration.requestedSources.length) {
    context.addIssue({
      code: 'custom',
      path: ['requestedSources'],
      message: 'Requested sources must be unique',
    });
  }
  const companyIds = new Set();
  for (const [index, company] of configuration.companies.entries()) {
    if (companyIds.has(company.companyId)) {
      context.addIssue({
        code: 'custom',
        path: ['companies', index, 'companyId'],
        message: 'Queued company identifiers must be unique',
      });
    }
    companyIds.add(company.companyId);
    if (
      company.apolloSearchDomain
      && !configuration.requestedSources.includes('apollo')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['companies', index, 'apolloSearchDomain'],
        message: 'Apollo search domains require Apollo',
      });
    }
  }
});

const queuedRun = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(120),
  source: z.literal('file'),
  status: z.literal('queued'),
  company_limit: z.number().int().min(1).max(25),
  configuration: z.unknown(),
  created_at: z.iso.datetime(),
}).strict();

const queuedTask = z.object({
  id: uuid,
  run_id: uuid,
  company_id: z.string().trim().min(1).max(240),
  company_name: z.string().trim().min(1).max(240),
  domain,
  status: z.literal('waiting'),
  created_at: z.iso.datetime(),
}).strict();

const claimRequest = z.object({
  workerId,
  availableSources: availableSources.default(allSources),
}).strict();

export function parseResearchQueueClaimRequest(body) {
  return claimRequest.parse(body);
}

function prepareQueuedRun(runValue) {
  const run = queuedRun.parse(runValue);
  const configuration = storedConfiguration.parse(run.configuration);
  return {run, configuration};
}

function prepareClaim(preparedRun, taskValues) {
  const {run, configuration} = preparedRun;
  const tasks = z.array(queuedTask).min(1).max(25).parse(taskValues);
  if (
    tasks.length !== run.company_limit
    || tasks.length !== configuration.companies.length
  ) {
    throw new Error('Queued research company counts do not match');
  }
  const requestedCompanies = new Map(
    configuration.companies.map(company => [company.companyId, company]),
  );
  for (const task of tasks) {
    const requested = requestedCompanies.get(task.company_id);
    if (
      task.run_id !== run.id
      || task.id !== stableResearchTaskId(run.id, task.company_id)
      || !requested
      || requested.domain !== task.domain
    ) {
      throw new Error('Queued research tasks do not match the reviewed request');
    }
  }
  return {
    run,
    configuration,
    tasks,
  };
}

async function failInvalidQueuedRun(client, runId, now) {
  const {error} = await client
    .from('research_runs')
    .update({
      status: 'failed',
      failure_message:
        'Queued request failed validation before the local worker started.',
      completed_at: now,
      updated_by: null,
      updated_at: now,
    })
    .eq('id', runId)
    .eq('status', 'queued');
  if (error) throw error;
}

export async function claimNextResearchRun(
  client,
  input,
  {
    now = () => new Date().toISOString(),
    pageSize = DEFAULT_CLAIM_PAGE_SIZE,
    // Retain the old option as a page-size alias for callers and tests that
    // supplied it before queue scanning became paginated.
    maxAttempts,
  } = {},
) {
  const request = claimRequest.parse(input);
  const requestedPageSize = maxAttempts ?? pageSize;
  const claimPageSize = Number.isInteger(requestedPageSize)
    ? Math.min(MAX_CLAIM_PAGE_SIZE, Math.max(1, requestedPageSize))
    : DEFAULT_CLAIM_PAGE_SIZE;
  const supportedSources = new Set(request.availableSources);
  let cursor = null;

  while (true) {
    let query = client
      .from('research_runs')
      .select('id,name,source,status,company_limit,configuration,created_at')
      .eq('status', 'queued')
      .eq('execution_protocol', 1);
    if (cursor) {
      query = query.or(
        `created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`,
      );
    }
    const {data: runValues, error: runError} = await query
      .order('created_at', {ascending: true})
      .order('id', {ascending: true})
      .limit(claimPageSize);
    if (runError) throw runError;
    if (!runValues?.length) return {claimed: false};

    for (const runValue of runValues) {
      let preparedRun;
      try {
        preparedRun = prepareQueuedRun(runValue);
      } catch {
        const invalidRunId = uuid.safeParse(runValue?.id);
        if (invalidRunId.success) {
          await failInvalidQueuedRun(client, invalidRunId.data, now());
        }
        continue;
      }
      if (
        preparedRun.configuration.requestedSources.some(
          requestedSource => !supportedSources.has(requestedSource),
        )
      ) {
        continue;
      }

      const {data: taskValues, error: taskError} = await client
        .from('research_tasks')
        .select('id,run_id,company_id,company_name,domain,status,created_at')
        .eq('run_id', runValue.id)
        .order('created_at', {ascending: true});
      if (taskError) throw taskError;

      let prepared;
      try {
        prepared = prepareClaim(preparedRun, taskValues || []);
      } catch {
        await failInvalidQueuedRun(client, preparedRun.run.id, now());
        continue;
      }

      const claimedAt = now();
      const configuration = {
        ...prepared.configuration,
        workerClaim: {
          workerId: request.workerId,
          claimedAt,
          availableSources: request.availableSources,
        },
      };
      const {data: claimed, error: claimError} = await client
        .from('research_runs')
        .update({
          status: 'running',
          configuration,
          failure_message: null,
          started_at: claimedAt,
          updated_by: null,
          updated_at: claimedAt,
        })
        .eq('id', prepared.run.id)
        .eq('status', 'queued')
        .select('id')
        .maybeSingle();
      if (claimError) throw claimError;
      if (!claimed) continue;

      const requestedCompanies = new Map(
        prepared.configuration.companies.map(company => [
          company.companyId,
          company,
        ]),
      );
      return {
        claimed: true,
        run: {
          id: prepared.run.id,
          name: prepared.run.name,
          requestedSources: prepared.configuration.requestedSources,
          apolloMaxPeople: prepared.configuration.apolloMaxPeople,
          procurementDays: prepared.configuration.procurementDays,
          companies: prepared.tasks.map(task => {
            const requested = requestedCompanies.get(task.company_id);
            return {
              companyId: task.company_id,
              companyName: task.company_name,
              domain: task.domain,
              ...(requested?.apolloSearchDomain
                ? {apolloSearchDomain: requested.apolloSearchDomain}
                : {}),
            };
          }),
        },
      };
    }

    const lastRun = runValues.at(-1);
    cursor = {
      createdAt: lastRun.created_at,
      id: lastRun.id,
    };
    if (runValues.length < claimPageSize) return {claimed: false};
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildResearchCompanyOptions,
  createQueuedPreviewRun,
} from './researchRunPlan.js';

test('builds stable contractor choices and reuses known domains', () => {
  const projects = [
    {
      MainContractorId: '123',
      MainContractor: 'BAM UK & Ireland',
      Name: 'School refurbishment',
    },
    {
      MainContractorId: '123',
      MainContractor: 'BAM UK & Ireland',
      Name: 'Hospital extension',
    },
    {
      MainContractor: 'Kier Construction',
    },
  ];
  const choices = buildResearchCompanyOptions(projects, [{
    companyName: 'BAM UK & Ireland',
    domain: 'bam.co.uk',
  }]);
  assert.equal(choices.length, 2);
  assert.deepEqual(choices[0], {
    id: 'sitefinder_contractor:123',
    name: 'BAM UK & Ireland',
    projectCount: 2,
    projectNames: ['School refurbishment', 'Hospital extension'],
    domain: 'bam.co.uk',
    apolloSearchDomain: 'ukandireland.bam.com',
  });
  assert.equal(
    choices[1]?.id,
    'sitefinder_contractor_name:kier-construction',
  );
});

test('creates a truthful queued preview run', () => {
  const request = {
    name: 'Pilot contractors',
    companies: [{
      companyId: 'sitefinder_contractor:123',
      companyName: 'BAM UK & Ireland',
      domain: 'bam.co.uk',
      apolloSearchDomain: 'ukandireland.bam.com',
    }],
  };
  const run = createQueuedPreviewRun(request, {
    idFactory: () => 'run-1',
    now: () => '2026-07-30T12:00:00.000Z',
  });
  assert.equal(run.status, 'queued');
  assert.equal(run.tasks[0]?.status, 'waiting');
  assert.match(run.tasks[0]?.pageTitle, /local worker/u);
  assert.equal(run.candidates.length, 0);
});

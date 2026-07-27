export const ATTIO_API = 'https://api.attio.com/v2';

export type AttioAttribute = {
  api_slug: string;
  title: string;
  type: string;
  is_writable: boolean;
  is_multiselect: boolean;
  is_archived: boolean;
  id?: { attribute_id?: string };
  config?: Record<string, unknown>;
};

export type AttioRecord = {
  id: { record_id: string };
  web_url?: string | null;
  values?: Record<string, unknown>;
};

type RequestOptions = {
  method?: string;
  body?: unknown;
};

export class AttioError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'AttioError';
    this.status = status;
    this.body = body;
  }
}

export class AttioClient {
  token: string;

  constructor(token: string) {
    this.token = token;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetch(`${ATTIO_API}${path}`, {
          method: options.method || 'GET',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(25_000),
        });
        const body = await response.json().catch(() => ({}));
        if (response.ok) return body as T;

        const message = String(
          (body as { message?: string })?.message || `Attio returned ${response.status}`,
        ).slice(0, 1000);
        const error = new AttioError(response.status, message, body);
        if (response.status !== 429 && response.status < 500) throw error;
        lastError = error;
      } catch (error) {
        if (error instanceof AttioError && error.status < 500 && error.status !== 429) throw error;
        lastError = error;
      }
      await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async listObjects() {
    const body = await this.request<{ data: Array<{
      api_slug: string;
      singular_noun: string;
      plural_noun: string;
    }> }>('/objects');
    return body.data;
  }

  async listAttributes(object: string) {
    const body = await this.request<{ data: AttioAttribute[] }>(
      `/objects/${encodeURIComponent(object)}/attributes?limit=500`,
    );
    return body.data.filter(attribute => !attribute.is_archived);
  }

  async queryRecords(object: string, filter: Record<string, unknown>, limit = 2) {
    const body = await this.request<{ data: AttioRecord[] }>(
      `/objects/${encodeURIComponent(object)}/records/query`,
      { method: 'POST', body: { filter, limit } },
    );
    return body.data;
  }

  async createRecord(object: string, values: Record<string, unknown>) {
    const body = await this.request<{ data: AttioRecord }>(
      `/objects/${encodeURIComponent(object)}/records`,
      { method: 'POST', body: { data: { values } } },
    );
    return body.data;
  }

  async updateRecord(object: string, recordId: string, values: Record<string, unknown>) {
    const body = await this.request<{ data: AttioRecord }>(
      `/objects/${encodeURIComponent(object)}/records/${encodeURIComponent(recordId)}`,
      { method: 'PATCH', body: { data: { values } } },
    );
    return body.data;
  }

  async assertRecord(object: string, matchingAttribute: string, values: Record<string, unknown>) {
    const body = await this.request<{ data: AttioRecord }>(
      `/objects/${encodeURIComponent(object)}/records?matching_attribute=${encodeURIComponent(matchingAttribute)}`,
      { method: 'PUT', body: { data: { values } } },
    );
    return body.data;
  }

  async createAttribute(
    object: string,
    definition: {
      title: string;
      api_slug: string;
      type: string;
      description: string;
      is_unique?: boolean;
      is_multiselect?: boolean;
      config?: Record<string, unknown>;
      relationship?: Record<string, unknown>;
    },
  ) {
    const body = await this.request<{ data: AttioAttribute }>(
      `/objects/${encodeURIComponent(object)}/attributes`,
      {
        method: 'POST',
        body: {
          data: {
            ...definition,
            is_required: false,
            is_unique: definition.is_unique ?? false,
            is_multiselect: definition.is_multiselect ?? false,
            config: definition.config || {},
          },
        },
      },
    );
    return body.data;
  }

  async listStatuses(object: string, attribute: string) {
    const body = await this.request<{ data: Array<{ title: string }> }>(
      `/objects/${encodeURIComponent(object)}/attributes/${encodeURIComponent(attribute)}/statuses?limit=500`,
    );
    return body.data;
  }

  async createStatus(object: string, attribute: string, title: string) {
    const body = await this.request<{ data: { title: string } }>(
      `/objects/${encodeURIComponent(object)}/attributes/${encodeURIComponent(attribute)}/statuses`,
      {
        method: 'POST',
        body: { data: { title, celebration_enabled: false } },
      },
    );
    return body.data;
  }
}

export function findAttribute(attributes: AttioAttribute[], aliases: string[]) {
  const normalisedAliases = aliases.map(normaliseSlug);
  return attributes.find(attribute => {
    const candidates = [attribute.api_slug, attribute.title].map(normaliseSlug);
    return candidates.some(candidate => normalisedAliases.includes(candidate));
  });
}

export function normaliseSlug(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export function recordReference(object: string, recordId: string) {
  return [{ target_object: object, target_record_id: recordId }];
}

export function optionalValues(values: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => {
      if (value === null || value === undefined || value === '') return false;
      return !Array.isArray(value) || value.length > 0;
    }),
  );
}

export function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

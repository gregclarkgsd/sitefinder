export type SourceKind =
  | "attio"
  | "pipedrive"
  | "company_website"
  | "company_pdf"
  | "companies_house"
  | "contracts_finder"
  | "find_a_tender";

export type RoleCategory =
  | "quantity_surveying"
  | "commercial"
  | "project_management"
  | "procurement"
  | "supply_chain"
  | "contracts"
  | "site_surveying"
  | "estimating"
  | "site_management";

export interface CompanySeed {
  id: string;
  name: string;
  domain: string;
  websiteUrl: string;
  source: "attio" | "pipedrive" | "file";
  sourceRecordId?: string;
  sourceIds?: {
    attio?: string[];
    pipedrive?: string[];
    file?: string[];
    sitefinder_contractor?: string[];
    sitefinder_client?: string[];
  };
  companyNumber?: string;
  postcode?: string;
  latitude?: number;
  longitude?: number;
  labels?: string[];
}

/**
 * A lossless CRM organisation snapshot. Unlike CompanySeed, a snapshot may
 * omit its domain because domainless CRM records still belong in the company
 * universe and its review queue. Only create a CompanySeed once a trustworthy
 * domain has been established.
 */
export interface CrmCompanySnapshot {
  id: string;
  name: string;
  domain?: string;
  websiteUrl?: string;
  source: "attio" | "pipedrive";
  sourceRecordId: string;
  labels?: string[];
}

export interface Evidence {
  id: string;
  companyId: string;
  sourceKind: SourceKind;
  sourceUrl: string;
  capturedAt: string;
  field: string;
  value: string;
  excerpt?: string;
  confidence: number;
}

export interface ContactPoint {
  value: string;
  status: "public" | "inferred" | "existing" | "unknown";
}

export interface ContactCandidate {
  id: string;
  companyId: string;
  name: string;
  normalizedName: string;
  jobTitle: string;
  roleCategory: RoleCategory;
  rolePriority: number;
  employmentStatus: "current" | "former" | "unknown";
  emails: ContactPoint[];
  phones: ContactPoint[];
  profileUrls: string[];
  evidenceIds: string[];
  confidence: number;
}

export interface CompanyFacts {
  legalName?: string;
  companyNumber?: string;
  companyStatus?: string;
  companyType?: string;
  incorporationDate?: string;
  registeredOffice?: string;
  sicCodes?: string[];
  accountsOverdue?: boolean;
}

export interface ProjectSignal {
  id: string;
  companyId: string;
  sourceKind: "contracts_finder" | "find_a_tender";
  title: string;
  stage?: string;
  publishedAt?: string;
  value?: number;
  currency?: string;
  role: "buyer" | "supplier" | "tenderer" | "mentioned";
  sourceUrl: string;
  evidenceIds: string[];
  confidence: number;
}

export interface WebsiteSignal {
  offices: string[];
  sectors: string[];
  projectNames: string[];
  hiringRoles: string[];
  genericEmails: string[];
  genericPhones: string[];
  socialUrls: string[];
}

export interface EnrichedCompany {
  company: CompanySeed;
  facts: CompanyFacts;
  contacts: ContactCandidate[];
  projects: ProjectSignal[];
  website: WebsiteSignal;
  evidence: Evidence[];
  pagesVisited: string[];
  pagesSkipped: Array<{ url: string; reason: string }>;
  warnings: string[];
  crawlStatus?: "completed" | "blocked" | "cancelled" | "failed" | "skipped";
  completedAt: string;
}

export interface AttioPersonSnapshot {
  recordId: string;
  name: string;
  emails: string[];
  jobTitle: string;
  companyRecordIds: string[];
}

export interface PipedrivePersonSnapshot {
  personId: string;
  name: string;
  emails: string[];
  jobTitle: string;
  organizationId?: string;
  organizationName?: string;
  labels: string[];
  /** True only when a note matched the bounded departed/stale vocabulary. */
  noteDepartedSignal?: true;
}

export interface ReconciliationFinding {
  kind:
    | "recoverable_title"
    | "pipedrive_only"
    | "company_conflict"
    | "departed_or_stale"
    | "duplicate_email"
    | "unusable";
  email?: string;
  pipedrivePersonId?: string;
  attioRecordId?: string;
  name: string;
  pipedriveJobTitle?: string;
  pipedriveCompany?: string;
  attioCompany?: string;
  reason: string;
}

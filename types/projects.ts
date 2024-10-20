import { AttestationBody } from "./attestationBody"

export interface ProjectQueryOptions {
  search: string
  categories: string[]
  orderBy?: string
  seed?: string
  limit?: number
  approved?: boolean
}

export interface ProjectMetadataSimple {
  id: string
  displayName: string
  profileImageUrl: string
  bio: string
}

export interface ProjectMetadata {
  id: string
  metadataId: string
  applicationId: string
  displayName: string
  impactCategory: string[]
  bio: string
  address: string
  profileImageUrl: string
  bannerImageUrl: string
  prelimResult: string
  reportReason: string
  recategorization?: string
  primaryCategory?: string
  includedInBallots?: number
  totalOP?: number
  rank?: number
  isOss?: boolean
}

export interface Project {
  id: string
  metadataId: string
  applicationId: string
  round: number
  bio: string
  impactCategory: string[]
  displayName: string
  websiteUrl: string
  applicant: ProjectApplicant
  applicantType: string
  profile: ProjectProfile
  impactDescription: string
  contributionDescription: string
  contributionLinks: ProjectContributionLink[]
  impactMetrics: ProjectImpactMetric[]
  fundingSources: ProjectFundingSource[]
  lists: any[]
  prelimResult: string
  reportReason: string
  includedInBallots?: number

  totalOP?: number
  rank?: number

  github: string[]
  packages: string[]

  attestationBody: AttestationBody | null
  agoraBody?: any
  
  osoSlug: string
  charmverseLink?: string

  metrics: ProjectMetrics | null
  metricsPercent: ProjectMetrics | null
  metricsPercentOss: ProjectMetrics | null

  application: ProjectApplication | null
}

export interface ProjectApplicant {
  address: ProjectAddress
  id: string
}

export interface ProjectAddress {
  address: string
  resolvedName: ProjectResolvedName
}

export interface ProjectResolvedName {
  address: string
  name: string
}

export interface ProjectProfile {
  profileImageUrl: string
  bannerImageUrl: string
  id: string
}

export interface ProjectContributionLink {
  type: string
  url: string
  description: string
}

export interface ProjectImpactMetric {
  description: string
  number: string
  url: string
}

export interface ProjectFundingSource {
  type: string
  currency: string
  amount: string
  description: string
  url?: string
}

export interface ProjectMetrics {
  project_name: string;
  application_id: string;
  is_oss: boolean;
  gas_fees: number;
  transaction_count: number;
  trusted_transaction_count: number;
  trusted_transaction_share: number;
  trusted_users_onboarded: number;
  daily_active_addresses: number;
  trusted_daily_active_users: number;
  monthly_active_addresses: number;
  trusted_monthly_active_users: number;
  recurring_addresses: number;
  trusted_recurring_users: number;
  power_user_addresses: number;
  openrank_trusted_users_count: number;
  log_gas_fees: number;
  log_transaction_count: number;
  log_trusted_transaction_count: number;
}

export interface ImpactStatement {
  question: string;
  answer: string;
}

export interface ProjectApplication {
  round: number;
  category: string;
  subcategory: string[];
  impactStatement: ImpactStatement[];
}

interface SocialLinks {
  website: string[];
  farcaster: string[];
  twitter: string | null;
  mirror: string | null;
}

interface Contract {
  address: string;
  deploymentTxHash: string;
  deployerAddress: string;
  chainId: number;
}

interface Funding {
  amount: string;
  year?: string;
  details: string;
}

interface Grant {
  grant: string;
  link: string | null;
  amount: string;
  date: string;
  details: string;
}

interface Revenue {
  amount: string;
  details: string;
}

interface RetroFundingGrant {
  grant: string;
  link: string | null;
  amount: string;
  date: string;
  details: string;
}

interface GrantsAndFunding {
  ventureFunding: Funding[];
  grants: Grant[];
  revenue: Revenue[];
  retroFunding: RetroFundingGrant[];
}

export interface Github {
  url: string
  name: string | null
  description: string | null
}

export interface Package {
  url: string
  name: string | null
  description: string | null
}

export interface AttestationBody {
  name: string;
  description: string;
  projectAvatarUrl: string;
  proejctCoverImageUrl?: string;
  projectCoverImageUrl?: string;
  category: string;
  osoSlug: string;
  socialLinks: SocialLinks;
  team: string[];
  github: string[] | Github[];
  links?: Github[];
  packages: string[] | Package[];
  contracts: Contract[];
  grantsAndFunding: GrantsAndFunding;
}
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

interface GrantsAndFunding {
  ventureFunding: Funding[];
  grants: Grant[];
  revenue: Revenue[];
}

export interface AttestationBody {
  name: string;
  description: string;
  projectAvatarUrl: string;
  proejctCoverImageUrl: string;
  category: string;
  osoSlug: string;
  socialLinks: SocialLinks;
  team: string[];
  github: string[];
  packages: string[];
  contracts: Contract[];
  grantsAndFunding: GrantsAndFunding;
}
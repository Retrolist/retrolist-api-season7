import express from 'express';
import axios from 'axios';
import { gql, request } from 'graphql-request'
import cors from 'cors';
import NodeCache from 'node-cache';
import fs from 'fs';
import path from 'path';
import { ProcessedAttestation, RawAttestation } from './types/attestations';
import { Project, ProjectFundingSource, ProjectMetadata } from './types/projects';

// Define the GraphQL endpoint
const url = "https://optimism.easscan.org/graphql";

// Define the query
const query = gql`
query Attestations($where: AttestationWhereInput) {
  attestations(where: $where) {
    id
    decodedDataJson
    time
  }
}
`;

// Define the variables
const variables = {
  where: {
    "schemaId": {
      "equals": "0xe035e3fe27a64c8d7291ae54c6e85676addcbc2d179224fe7fc1f7f05a8c6eac"
    },
    "attester": {
      "equals": "0xF6872D315CC2E1AfF6abae5dd814fd54755fE97C"
    }
  }
};

// Initialize caches
const mainCache = new NodeCache({ stdTTL: 60 }); // 1 minute TTL for main data
const metadataCache = new NodeCache({ stdTTL: 0 }); // Infinite TTL for metadata

const CACHE_DIR = './cache/projects';

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Load metadata cache from file if it exists
fs.readdirSync(CACHE_DIR).forEach(file => {
  const filePath = path.join(CACHE_DIR, file);
  const fileData = fs.readFileSync(filePath, 'utf8');
  const key = `https://storage.retrofunding.optimism.io/ipfs/${file.replace('.json', '')}`;
  const data = JSON.parse(fileData);
  metadataCache.set(key, data);
});

// Save metadata cache to file
function saveMetadataCacheToFile(url: string, data: any) {
  const hash = url.split('/').pop();
  if (!hash) return;

  const filePath = path.join(CACHE_DIR, `${hash}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Function to parse decodedDataJson
function parseDecodedDataJson(decodedDataJson: string) {
  const decodedData = JSON.parse(decodedDataJson);
  const parsedData: { [key: string]: any } = {};
  decodedData.forEach((item: any) => {
    parsedData[item.name] = item.value.value;
  });
  return parsedData;
}

// Function to fetch metadata from URL
async function fetchMetadata(url: string) {
  const cachedMetadata = metadataCache.get(url);
  if (cachedMetadata) {
    return cachedMetadata;
  }

  try {
    const response = await axios.get(url);
    const data = response.data;
    metadataCache.set(url, data);
    saveMetadataCacheToFile(url, data); // Save cache to file after setting new data
    return data;
  } catch (error) {
    console.error(`Error fetching metadata from ${url}:`, error);
    return null;
  }
}

// Function to fetch and process data
async function fetchAndProcessData(): Promise<ProcessedAttestation[]> {
  const cacheKey = 'attestations';
  const cachedData = mainCache.get(cacheKey);

  if (cachedData) {
    return cachedData as ProcessedAttestation[];
  }

  try {
    const data: { attestations: RawAttestation[] } = await request(url, query, variables);

    const attestations = data.attestations;
    attestations.sort((a, b) => b.time - a.time)

    // Map to store the latest attestation for each projectRefUID
    const latestAttestationsMap: { [key: string]: any } = {};
    const allAttestationsMap: { [key: string]: any[] } = {};

    // Process each attestation
    for (const attestation of attestations) {
      const parsedData = parseDecodedDataJson(attestation.decodedDataJson);
      const projectRefUID = parsedData['projectRefUID'];
      const metadataUrl = parsedData['metadataUrl'];
      const body = await fetchMetadata(metadataUrl);

      if (!allAttestationsMap[projectRefUID]) {
        allAttestationsMap[projectRefUID] = [];
      }

      allAttestationsMap[projectRefUID].push({
        ...attestation,
        parsedData,
        body
      });

      if (
        !latestAttestationsMap[projectRefUID] ||
        attestation.time > latestAttestationsMap[projectRefUID].time
      ) {
        latestAttestationsMap[projectRefUID] = {
          ...attestation,
          parsedData,
          body,
          revisions: []
        };
      }
    }

    // Add revisions to each latest attestation
    Object.keys(latestAttestationsMap).forEach((projectRefUID) => {
      const latestAttestation = latestAttestationsMap[projectRefUID];
      const allAttestations = allAttestationsMap[projectRefUID];

      allAttestations.forEach((attestation) => {
        if (attestation.id !== latestAttestation.id) {
          latestAttestation.revisions.push(attestation);
        }
      });
    });

    const processedData: ProcessedAttestation[] = Object.values(latestAttestationsMap);
    processedData.sort((a, b) => b.time - a.time)
    mainCache.set(cacheKey, processedData);
    return processedData;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
}

async function fetchProjects(): Promise<ProjectMetadata[]> {
  const cacheKey = 'projects';
  const cachedData = mainCache.get(cacheKey);

  if (cachedData) {
    return cachedData as ProjectMetadata[];
  }

  const attestations = await fetchAndProcessData()

  const projects = attestations.map(attestation => ({
    id: attestation.id,
    name: attestation.parsedData.name,
    displayName: attestation.parsedData.name,
    description: attestation.body?.description || '',
    bio: attestation.body?.description || '',
    address: attestation.parsedData.farcasterID.hex,
    bannerImageUrl: attestation.body?.proejctCoverImageUrl || '',
    profileImageUrl: attestation.body?.projectAvatarUrl || '',
    impactCategory: [ attestation.parsedData.category ],
    primaryCategory: attestation.parsedData.category,
    recategorization: attestation.parsedData.category,
    prelimResult: 'Keep',
    reportReason: '',
    includedInBallots: 0,
  }))

  mainCache.set(cacheKey, projects);

  return projects
}

function parseGrantType(grantType: string): [string, string] {
  switch (grantType) {
    case 'venture-funding': return ['Fundraising', 'USD']
    case 'revenue': return ['Revenue', 'USD']
    case 'foundation-grant': return ['Foundation Grant', 'OP']
    case 'token-house-mission': return ['Token House Mission', 'OP']
    default: return [grantType, 'USD']
  }
}

function etherscanUrl(address: string, chainId: number): string {
  switch (chainId) {
    case 10: return `https://optimistic.etherscan.io/address/${address}`
    case 8453: return `https://basescan.org/address/${address}`
    case 34443: return `https://explorer.mode.network/address/${address}`
    case 7777777: return `https://explorer.zora.energy/address/${address}`
    case 252: return `https://fraxscan.com/address/${address}`
    default: return 'https://retrolist.app'
  }
}

function hyphenToCapitalize(input: string): string {
  // Split the input string by "-"
  let words = input.split('-');

  // Capitalize the first letter of the first word
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);

  // Join the words with a space
  let result = parseFloat(words[0]) ? words.join(' - ') : words.join(' ');

  return result;
}

async function fetchProject(id: string): Promise<Project> {
  const cacheKey = 'project-' + id;
  const cachedData = mainCache.get(cacheKey);

  if (cachedData) {
    return cachedData as Project;
  }

  const attestations = await fetchAndProcessData()
  const attestation = attestations.find(attestation => attestation.id === id)
  if (!attestation) {
    throw new Error(`Project not found`)
  }

  const fundingSources: ProjectFundingSource[] = []

  if (attestation.body?.grantsAndFunding) {
    for (const grant of attestation.body.grantsAndFunding.ventureFunding) {
      const [ type, currency ] = parseGrantType('venture-funding')
      fundingSources.push({
        type,
        currency,
        amount: hyphenToCapitalize(grant.amount),
        description: grant.details,
      })
    }

    for (const grant of attestation.body.grantsAndFunding.grants) {
      const [ type, currency ] = parseGrantType(grant.grant)
      fundingSources.push({
        type,
        currency,
        amount: hyphenToCapitalize(grant.amount),
        description: grant.details,
        url: grant.link || undefined,
      })
    }

    for (const grant of attestation.body.grantsAndFunding.revenue) {
      const [ type, currency ] = parseGrantType('revenue')
      fundingSources.push({
        type,
        currency,
        amount: hyphenToCapitalize(grant.amount),
        description: grant.details,
      })
    }
  }

  const project = {
    id: attestation.id,
    displayName: attestation.parsedData.name,
    contributionDescription: attestation.body?.description || '',
    impactDescription: '',
    bio: attestation.body?.description || '',
    profile: {
      bannerImageUrl: attestation.body?.proejctCoverImageUrl || '',
      profileImageUrl: attestation.body?.projectAvatarUrl || '',
      id: attestation.id,
    },
    websiteUrl: attestation.body?.socialLinks.website[0] || '',
    applicant: {
      address: {
        address: attestation.parsedData.farcasterID.hex,
        resolvedName: {
          address: attestation.parsedData.farcasterID.hex,
          name: '',
        }
      },
      id: attestation.parsedData.farcasterID.hex,
    },
    applicantType: "PROJECT",
    impactCategory: [ attestation.parsedData.category ],
    prelimResult: 'Keep',
    reportReason: '',
    includedInBallots: 0,
    lists: [],

    contributionLinks: attestation.body?.contracts.map(contract => ({
      description: contract.address,
      type: contract.chainId.toString(),
      url: etherscanUrl(contract.address, contract.chainId),
    })) || [],
    fundingSources,
    impactMetrics: [],

    github: attestation.body?.github || [],
    packages: attestation.body?.packages || [],
  }

  mainCache.set(cacheKey, project);

  return project
}

async function fetchProjectCount() {
  const cacheKey = 'projectCount';
  const cachedData = mainCache.get(cacheKey);

  if (cachedData) {
    return cachedData;
  }

  const projects = await fetchProjects();

  const countMap = projects.reduce((result, currentItem) => {
    const groupKey = currentItem.impactCategory[0];
    if (!result[groupKey]) {
      result[groupKey] = 0;
    }
    result[groupKey] += 1;
    return result;
  }, {} as Record<string, number>);

  const categories = Object.entries(countMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const result = {
    total: projects.length,
    categories,
  }

  mainCache.set(cacheKey, result);

  return result
}

// Create an Express app
const app = express();
const port = 4201;

// Use CORS middleware
app.use(cors());

// Define the endpoint
app.get('/attestations', async (req, res) => {
  try {
    const attestations = await fetchAndProcessData();
    res.json(attestations);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch attestations' });
  }
});

app.get('/projects/count', async (req, res) => {
  try {
    const count = await fetchProjectCount();
    res.json(count);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch project count' });
  }
})

app.get('/projects/:id', async (req, res) => {
  try {
    const project = await fetchProject(req.params.id);
    res.json(project);
  } catch (error: any) {
    if (error.message == 'Project not found') {
      res.status(404).json({ error: 'Project not found' });
    } else {
      res.status(500).json({ error: 'Failed to fetch project' });
    }
  }
});

app.get('/projects', async (req, res) => {
  try {
    const projects = await fetchProjects();
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

fetchAndProcessData()
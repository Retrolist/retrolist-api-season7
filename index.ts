import express from 'express';
import axios from 'axios';
import { gql, request } from 'graphql-request'
import cors from 'cors';
import NodeCache from 'node-cache';
import fs from 'fs';
import path from 'path';
import { RawAttestation } from './types';

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
async function fetchAndProcessData() {
  const cacheKey = 'attestations';
  const cachedData = mainCache.get(cacheKey);

  if (cachedData) {
    return cachedData;
  }

  try {
    const data: { attestations: RawAttestation[] } = await request(url, query, variables);

    const attestations = data.attestations;

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

    const processedData = Object.values(latestAttestationsMap);
    mainCache.set(cacheKey, processedData);
    return processedData;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
}

// Create an Express app
const app = express();
const port = 4200;

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

// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

fetchAndProcessData()
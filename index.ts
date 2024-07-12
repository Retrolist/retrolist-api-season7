import { config as dotenv } from "dotenv";
dotenv();

import express from "express";
import axios from "axios";
import YAML from 'yaml';
import { gql, request } from "graphql-request";
import cors from "cors";
import NodeCache from "node-cache";
import fs from "fs";
import path from "path";
import { ProcessedAttestation, RawAttestation } from "./types/attestations";
import {
  Project,
  ProjectFundingSource,
  ProjectMetadata,
} from "./types/projects";
import { Pool } from "pg";
import { chain, groupBy, uniq, uniqBy } from "lodash";

interface FarcasterComment {
  fid: number;
  timestamp: number;
  username: string;
  hash: string;
}

const eligibility = JSON.parse(
  fs.readFileSync("data/eligibility.json", "utf-8")
);
const farcasterCommentThreads = JSON.parse(
  fs.readFileSync("data/farcasterCommentThreads.json", "utf-8")
);
const metrics = groupBy(JSON.parse(fs.readFileSync("data/metrics.json", "utf-8")), 'application_id');
// const osoContracts = JSON.parse(
//   fs.readFileSync("data/oso_contracts.json", "utf-8")
// );

// PostgreSQL connection setup
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: 5432, // Default PostgreSQL port
});

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
    schemaId: {
      equals:
        "0xe035e3fe27a64c8d7291ae54c6e85676addcbc2d179224fe7fc1f7f05a8c6eac",
    },
    attester: {
      equals: "0xF6872D315CC2E1AfF6abae5dd814fd54755fE97C",
    },
  },
};

const variablesR4 = {
  where: {
    schemaId: {
      equals:
        "0x88b62595c76fbcd261710d0930b5f1cc2e56758e155dea537f82bf0baadd9a32",
    },
    attester: {
      equals: "0xF6872D315CC2E1AfF6abae5dd814fd54755fE97C",
    },
  },
};

// Initialize caches
// const mainCache = new NodeCache({ stdTTL: 60 }); // 1 minute TTL for main data
const fastCache = new NodeCache({ stdTTL: 60 }); // 1 minute TTL for main data
const mainCache = new NodeCache({ stdTTL: 0 }); // Infinite TTL for finalized main data
const metadataCache = new NodeCache({ stdTTL: 0 }); // Infinite TTL for metadata

const CACHE_DIR = "./cache/projects";

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Load metadata cache from file if it exists
fs.readdirSync(CACHE_DIR).forEach((file) => {
  const filePath = path.join(CACHE_DIR, file);
  const fileData = fs.readFileSync(filePath, "utf8");
  const key = `https://storage.retrofunding.optimism.io/ipfs/${file.replace(
    ".json",
    ""
  )}`;
  const data = JSON.parse(fileData);
  metadataCache.set(key, data);
});

// Save metadata cache to file
function saveMetadataCacheToFile(url: string, data: any) {
  const hash = url.split("/").pop();
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
  const cacheKey = "attestations";
  const cachedData = mainCache.get(cacheKey);

  if (cachedData) {
    return cachedData as ProcessedAttestation[];
  }

  try {
    const data: { attestations: RawAttestation[] } = await request(
      url,
      query,
      variables
    );

    const attestations = data.attestations;
    attestations.sort((a, b) => b.time - a.time);

    // Map to store the latest attestation for each projectRefUID
    const latestAttestationsMap: { [key: string]: any } = {};
    const allAttestationsMap: { [key: string]: any[] } = {};

    // Process each attestation
    for (const attestation of attestations) {
      const parsedData = parseDecodedDataJson(attestation.decodedDataJson);
      const projectRefUID = parsedData["projectRefUID"];
      const metadataUrl = parsedData["metadataUrl"];
      const body = await fetchMetadata(metadataUrl);

      if (!allAttestationsMap[projectRefUID]) {
        allAttestationsMap[projectRefUID] = [];
      }

      allAttestationsMap[projectRefUID].push({
        ...attestation,
        parsedData,
        body,
      });

      if (
        !latestAttestationsMap[projectRefUID] ||
        attestation.time > latestAttestationsMap[projectRefUID].time
      ) {
        latestAttestationsMap[projectRefUID] = {
          ...attestation,
          parsedData,
          body,
          revisions: [],
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

    const processedData: ProcessedAttestation[] = Object.values(
      latestAttestationsMap
    );
    processedData.sort((a, b) => b.time - a.time);
    mainCache.set(cacheKey, processedData);
    return processedData;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
}

async function fetchAndProcessR4Submissions(): Promise<Set<string>> {
  const cacheKey = "attestationsR4Submissions";
  const cachedData = mainCache.get(cacheKey);

  if (cachedData) {
    return cachedData as Set<string>;
  }

  try {
    const data: { attestations: RawAttestation[] } = await request(
      url,
      query,
      variablesR4
    );

    const attestations = data.attestations;
    attestations.sort((a, b) => b.time - a.time);

    const processedData: Set<string> = new Set();

    // Process each attestation
    for (const attestation of attestations) {
      const parsedData = parseDecodedDataJson(attestation.decodedDataJson);
      processedData.add(parsedData.projectRefUID);
    }

    mainCache.set(cacheKey, processedData);
    return processedData;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
}

function getPrelimResult(projectId: string): string {
  const project = eligibility.find((x: any) => x.projectRefUID == projectId);

  if (!project) return "Missing";

  if (project.status == "pass") return "Keep";
  if (project.status == "fail") return "Remove";

  return "#N/A";
}

async function fetchProjects(): Promise<ProjectMetadata[]> {
  const cacheKey = "projects";
  const cachedData = mainCache.get(cacheKey);

  if (cachedData) {
    return cachedData as ProjectMetadata[];
  }

  const attestations = await fetchAndProcessData();
  const submissions = await fetchAndProcessR4Submissions();

  const projects = attestations.map((attestation) => ({
    id: attestation.parsedData.projectRefUID,
    name: attestation.parsedData.name,
    displayName: attestation.parsedData.name,
    description: attestation.body?.description || "",
    bio: attestation.body?.description || "",
    address: attestation.parsedData.farcasterID.hex,
    bannerImageUrl: attestation.body?.proejctCoverImageUrl || "",
    profileImageUrl: attestation.body?.projectAvatarUrl || "",
    impactCategory: [attestation.parsedData.category],
    primaryCategory: attestation.parsedData.category,
    recategorization: attestation.parsedData.category,
    prelimResult: getPrelimResult(attestation.parsedData.projectRefUID),
    reportReason: "",
    includedInBallots: 0,
  }));

  mainCache.set(cacheKey, projects);

  return projects;
}

function parseGrantType(grantType: string): [string, string] {
  switch (grantType) {
    case "venture-funding":
      return ["Fundraising", "USD"];
    case "revenue":
      return ["Revenue", "USD"];
    case "foundation-grant":
      return ["Foundation Grant", "OP"];
    case "token-house-mission":
      return ["Token House Mission", "OP"];
    default:
      return [grantType, "USD"];
  }
}

function etherscanUrl(address: string, chainId: number): string {
  switch (chainId) {
    case 10:
      return `https://optimistic.etherscan.io/address/${address}`;
    case 8453:
      return `https://basescan.org/address/${address}`;
    case 34443:
      return `https://explorer.mode.network/address/${address}`;
    case 7777777:
      return `https://explorer.zora.energy/address/${address}`;
    case 252:
      return `https://fraxscan.com/address/${address}`;
    default:
      return "https://retrolist.app";
  }
}

function osoChainId(chainName: string) {
  switch (chainName) {
    case "optimism":
    case "any_evm":
      return 10;
    case "base":
      return 8453;
    case "mode":
      return 34443;
    case "zora":
      return 7777777;
    case "frax":
      return 252;
    default:
      return 0;
  }
}

function hyphenToCapitalize(input: string): string {
  // Split the input string by "-"
  let words = input.split("-");

  // Capitalize the first letter of the first word
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);

  // Join the words with a space
  let result = parseFloat(words[0]) ? words.join(" - ") : words.join(" ");

  return result;
}

async function fetchProject(id: string): Promise<Project> {
  const cacheKey = "project-" + id;
  const cachedData = mainCache.get(cacheKey);

  if (cachedData) {
    return cachedData as Project;
  }

  const attestations = await fetchAndProcessData();
  const attestation = attestations.find(
    (attestation) =>
      attestation.id === id || attestation.parsedData?.projectRefUID === id
  );
  if (!attestation) {
    throw new Error(`Project not found`);
  }

  // const submissions = await fetchAndProcessR4Submissions();

  const fundingSources: ProjectFundingSource[] = [];

  if (attestation.body?.grantsAndFunding) {
    for (const grant of attestation.body.grantsAndFunding.ventureFunding) {
      const [type, currency] = parseGrantType("venture-funding");
      fundingSources.push({
        type,
        currency,
        amount: hyphenToCapitalize(grant.amount),
        description: grant.details,
      });
    }

    for (const grant of attestation.body.grantsAndFunding.grants) {
      const [type, currency] = parseGrantType(grant.grant);
      fundingSources.push({
        type,
        currency,
        amount: hyphenToCapitalize(grant.amount),
        description: grant.details,
        url: grant.link || undefined,
      });
    }

    for (const grant of attestation.body.grantsAndFunding.revenue) {
      const [type, currency] = parseGrantType("revenue");
      fundingSources.push({
        type,
        currency,
        amount: hyphenToCapitalize(grant.amount),
        description: grant.details,
      });
    }
  }

  const attestationContracts =
    attestation.body?.contracts.map((contract) => ({
      description: contract.address,
      type: contract.chainId.toString(),
      url: etherscanUrl(contract.address, contract.chainId),
    })) || [];

  // const osoProjectContracts = osoContracts[
  //   attestation.parsedData.projectRefUID
  // ].map((contract: any) => ({
  //   description: contract.contract_address,
  //   type: osoChainId(contract.network).toString(),
  //   url: etherscanUrl(contract.contract_address, osoChainId(contract.network)),
  // }));

  const osoProjectContracts = []

  if (attestation.body?.osoSlug) {
    try {
      const response = await axios.get(`https://raw.githubusercontent.com/opensource-observer/oss-directory/main/data/projects/${attestation.body.osoSlug[0].toLowerCase()}/${attestation.body.osoSlug.toLowerCase()}.yaml`)
      const data = YAML.parse(response.data)
      const filtered = data.blockchain?.filter((contract: any) => contract.tags.indexOf('contract') != -1)
      if (filtered) {
        for (const contract of filtered) {
          for (const network of contract.networks) {
            const chainId = osoChainId(network)
            if (chainId) {
              osoProjectContracts.push({
                description: contract.address,
                type: chainId.toString(),
                url: etherscanUrl(contract.address, chainId),
              })
            }
          }
        }
      }
    } catch (err) {
      console.error(err)
    }
  }

  const project = {
    id: attestation.parsedData.projectRefUID,
    displayName: attestation.parsedData.name,
    contributionDescription: attestation.body?.description || "",
    impactDescription: "",
    bio: attestation.body?.description || "",
    profile: {
      bannerImageUrl: attestation.body?.proejctCoverImageUrl || "",
      profileImageUrl: attestation.body?.projectAvatarUrl || "",
      id: attestation.id,
    },
    websiteUrl: attestation.body?.socialLinks.website[0] || "",
    applicant: {
      address: {
        address: attestation.parsedData.farcasterID.hex,
        resolvedName: {
          address: attestation.parsedData.farcasterID.hex,
          name: "",
        },
      },
      id: attestation.parsedData.farcasterID.hex,
    },
    applicantType: "PROJECT",
    impactCategory: [attestation.parsedData.category],
    prelimResult: getPrelimResult(attestation.parsedData.projectRefUID),
    reportReason: "",
    includedInBallots: 0,
    lists: [],

    contributionLinks: uniqBy(
      [...attestationContracts, ...osoProjectContracts],
      "description"
    ),
    fundingSources,
    impactMetrics: [],

    github: attestation.body?.github || [],
    packages: attestation.body?.packages || [],

    osoSlug: attestation.body?.osoSlug || "",
    metrics: metrics[attestation.parsedData.projectRefUID] ? metrics[attestation.parsedData.projectRefUID][0] : null,
  };

  mainCache.set(cacheKey, project);

  return project;
}

async function fetchProjectCount() {
  const cacheKey = "projectCount";
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
    eligible: projects.filter((x) => x.prelimResult == "Keep").length,
    categories,
  };

  mainCache.set(cacheKey, result);

  return result;
}

// Fetch comments hash
async function fetchFarcasterComments(fid: number, hash: string) {
  const cacheKey = `COMMENTS_${fid}_${hash}`;
  const cachedData = fastCache.get(cacheKey);

  if (cachedData) {
    return cachedData;
  }

  const response = await axios.get(
    "https://hub-api.neynar.com/v1/castsByParent",
    {
      params: {
        fid,
        hash,
      },
      headers: {
        api_key: process.env.NEYNAR_API_KEY,
      },
    }
  );

  const fids = uniq(response.data.messages.map((x: any) => x.data.fid));

  const usersResponse = await axios.get(
    "https://api.neynar.com/v2/farcaster/user/bulk",
    {
      params: {
        fids: fids.join(","),
      },
      headers: {
        api_key: process.env.NEYNAR_API_KEY,
      },
    }
  );

  const usernameMap: { [fid: number]: string } = {};
  for (const user of usersResponse.data.users) {
    usernameMap[user.fid] = user.username;
  }

  const comments: FarcasterComment[] = response.data.messages.map((x: any) => ({
    fid: x.data.fid,
    timestamp: x.data.timestamp,
    username: usernameMap[x.data.fid],
    hash: x.hash,
  }));

  comments.sort((a, b) => b.timestamp - a.timestamp);

  mainCache.set(cacheKey, comments);

  return comments;
}

async function fetchProjectComments(projectId: string) {
  // TODO: Get project farcaster thread hash
  const hash = farcasterCommentThreads[projectId];

  if (!hash) {
    throw new Error("Project not found");
  }

  try {
    return {
      hash,
      comments: await fetchFarcasterComments(702265, hash),
    };
  } catch (err) {
    return {
      hash,
      comments: [],
    };
  }
}

// Create an Express app
const app = express();
const port = 4201;

// Use CORS middleware
app.use(express.json());
app.use(cors());

// Define the endpoint
app.get("/attestations", async (req, res) => {
  try {
    const attestations = await fetchAndProcessData();
    res.json(attestations);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch attestations" });
  }
});

app.get("/projects/count", async (req, res) => {
  try {
    const count = await fetchProjectCount();
    res.json(count);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch project count" });
  }
});

app.get("/projects/:id/comments", async (req, res) => {
  try {
    const comments = await fetchProjectComments(req.params.id);
    res.json(comments);
  } catch (error: any) {
    if (error.message == "Project not found") {
      res.status(404).json({ error: "Project not found" });
    } else {
      res.status(500).json({ error: "Failed to fetch project" });
    }
  }
});

app.get("/projects/:id", async (req, res) => {
  try {
    const project = await fetchProject(req.params.id);
    res.json(project);
  } catch (error: any) {
    if (error.message == "Project not found") {
      res.status(404).json({ error: "Project not found" });
    } else {
      console.error(error)
      res.status(500).json({ error: "Failed to fetch project" });
    }
  }
});

app.get("/projects", async (req, res) => {
  try {
    const projects = await fetchProjects();
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch projects" });
  }
});

// Cloudflare Turnstile site and secret keys
const TURNSTILE_SECRET_KEY = "your_turnstile_secret_key";

// Verify Turnstile token
const verifyTurnstileToken = async (token: string): Promise<boolean> => {
  const response = await axios.post(
    `https://challenges.cloudflare.com/turnstile/v0/siteverify`,
    {},
    {
      params: {
        secret: TURNSTILE_SECRET_KEY,
        response: token,
      },
    }
  );

  return response.data.success;
};

// Endpoint to post a message
app.post("/report", async (req, res) => {
  try {
    const { reason, projectId } = req.body;

    if (!reason || !projectId) {
      return res
        .status(400)
        .json({
          error: "Reason, Project ID and Turnstile token are required.",
        });
    }

    // Verify Turnstile token
    // const isTokenValid = await verifyTurnstileToken(turnstileToken);

    // if (!isTokenValid) {
    //   return res.status(403).json({ error: 'Invalid Turnstile token.' });
    // }

    // Insert message into PostgreSQL database
    const client = await pool.connect();
    try {
      await client.query(
        "INSERT INTO reports (round, project_id, reason) VALUES ('retro-4', $1, $2)",
        [projectId, reason]
      );
      res.status(201).json({ message: "Report posted successfully." });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Error posting report:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

// Endpoint to get all reports
app.get("/report/:round", async (req, res) => {
  const { round } = req.params;

  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT * FROM reports WHERE round = $1",
        [round]
      );
      res.status(200).json(result.rows);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Error retrieving reports:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

// Endpoint to get reports by project_id
app.get("/report/:round/:projectId", async (req, res) => {
  const { projectId, round } = req.params;

  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT * FROM reports WHERE round = $1 AND project_id = $2",
        [round, projectId]
      );
      res.status(200).json(result.rows);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Error retrieving reports:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

fetchAndProcessData();

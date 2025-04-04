import { config as dotenv } from "dotenv";
dotenv();

import express, { application } from "express";
import axios from "axios";
import YAML from "yaml";
import { gql, request } from "graphql-request";
import cors from "cors";
import NodeCache from "node-cache";
import fs from "fs";
import path from "path";
import { ProcessedAttestation, RawAttestation } from "./types/attestations";
import {
  Project,
  ProjectApplication,
  ProjectFundingSource,
  ProjectMetadata,
} from "./types/projects";
import { Pool } from "pg";
import { chain, groupBy, uniq, uniqBy } from "lodash";
import { MetricsGarden, MetricsGardenProfile } from "./types/metricsGarden";
import { dbClient } from "./db";
import { fetchContracts } from "./index_contracts";

const CURRENT_ROUND = [7, 8];

const ROUND_SLUG_MAPPING: { [round: number]: string } = {
  5: "5",
  6: "6",
  7: "S7 Dev Tooling",
  8: "S7 Onchain Builders",
};

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
const metrics = groupBy(
  JSON.parse(fs.readFileSync("data/metrics.json", "utf-8")),
  "application_id"
);
const agoraMetrics = JSON.parse(
  fs.readFileSync("data/agora_metrics.json", "utf-8")
);
const rewardMetrics = JSON.parse(
  fs.readFileSync("data/reward_metrics.json", "utf-8")
);
const rewardMetricsOss = JSON.parse(
  fs.readFileSync("data/reward_metrics_oss.json", "utf-8")
);
const rewardData = JSON.parse(fs.readFileSync("data/reward.json", "utf-8"));
const rewardDataRound7 = JSON.parse(
  fs.readFileSync("data/reward_round7.json", "utf-8")
);
const rewardDataRound8 = JSON.parse(
  fs.readFileSync("data/reward_round8.json", "utf-8")
);
const categoryR5 = JSON.parse(
  fs.readFileSync("data/category_r5.json", "utf-8")
);
const chainList = JSON.parse(fs.readFileSync("chainList.json", "utf-8"));
// const osoContracts = JSON.parse(
//   fs.readFileSync("data/oso_contracts.json", "utf-8")
// );

// Define the GraphQL endpoint
const url = "https://optimism.easscan.org/graphql";

// Define the query
const query = gql`
  query Attestations($where: AttestationWhereInput) {
    attestations(where: $where, orderBy: { time: desc }) {
      id
      decodedDataJson
      time
      refUID
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
        "0x2169b74bfcb5d10a6616bbc8931dc1c56f8d1c305319a9eeca77623a991d4b80",
    },
    attester: {
      equals: "0xF6872D315CC2E1AfF6abae5dd814fd54755fE97C",
    },
  },
};

const variablesApplication = {
  where: {
    schemaId: {
      equals:
        "0x2169b74bfcb5d10a6616bbc8931dc1c56f8d1c305319a9eeca77623a991d4b80",
    },
    attester: {
      equals: "0xF6872D315CC2E1AfF6abae5dd814fd54755fE97C",
    },
  },
};

const variablesMG = {
  where: {
    schemaId: {
      equals:
        "0xc9bc703e3c48be23c1c09e2f58b2b6657e42d8794d2008e3738b4ab0e2a3a8b6",
    },
    attester: {
      equals: "0x7484aABFef9f39464F332e632047983b67571C0a",
    },
  },
};

const TEST_PROJECTS = [
  "0x83b46efce8ff1937a49883b323b22d3483d1843522f614ab4f20cc20545067bb",
  "0xbdd994bf9b06072f6f8603591c8907ca5a09a21fa14dcda0cebeaaea4e074d9b",
  "0x52d53d44856f5a356053e55e3ad339d7207486b0210fe48aa2c1a0ec79c55d9c",
  "0x54eef6526ed4a28f771e2bc9b4a18884afcd92437cbee5ea4175c0a6b8970ac2",
  "0xf2da6b1d4ab4bcc61b5318f3b2f2f7d568fb0e6a9fbf0ca240130160953ea8fa",
  "0xc1311ae4d779bb4a627759aaf66dfcd6da029a770adf015035d86e4c682f6a35",
  "0x1c0db0217d2aafd77b89d864fb87ef9d52bca0a2fc05e6faabe22ac81ec49503",
  "0xb199463048fa09ea0bf66027e2e9b73c6268b342aaf77d5aa1088a0afd801e12",
  "0x965d10dd8af44d0286af95744897ac7e066f92114c080c021e628f4af3eda298",
];

let applicationRound: { [applicationId: string]: number } = {};
let applicationData: {
  [projectRefUid: string]: { [round: number]: ProjectApplication };
} = {};
let projectApplications: { [projectRefUid: string]: Set<string> } = {};

// Initialize caches
const mainCache = new NodeCache({ stdTTL: 10 }); // [improved] 10s TTL for main data
const slowCache = new NodeCache({ stdTTL: 600 }); // 10 minute TTL for slow cache for background project downloading
const fastCache = new NodeCache({ stdTTL: 60 }); // 1 minute TTL for main data
// const mainCache = new NodeCache({ stdTTL: 0 }); // Infinite TTL for finalized main data
const metadataCache = new NodeCache({ stdTTL: 0 }); // Infinite TTL for metadata

let cachedSmartAttestations: { [name: string]: RawAttestation[] } = {};
let smartAttestationStarted: Set<String> = new Set();

const PROJECT_CACHE_DIR = "./cache/projects";
const ATTESTATION_CACHE_DIR = "./cache/attestations";

// Ensure cache directory exists
if (!fs.existsSync(PROJECT_CACHE_DIR))
  fs.mkdirSync(PROJECT_CACHE_DIR, { recursive: true });
if (!fs.existsSync(ATTESTATION_CACHE_DIR))
  fs.mkdirSync(ATTESTATION_CACHE_DIR, { recursive: true });

// Load metadata cache from file if it exists
fs.readdirSync(PROJECT_CACHE_DIR).forEach((file) => {
  const filePath = path.join(PROJECT_CACHE_DIR, file);
  const fileData = fs.readFileSync(filePath, "utf8");
  const key = `ipfs-${file.replace(".json", "")}`;
  const data = JSON.parse(fileData);
  metadataCache.set(key, data);
});
fs.readdirSync(ATTESTATION_CACHE_DIR).forEach((file) => {
  const filePath = path.join(ATTESTATION_CACHE_DIR, file);
  const fileData = fs.readFileSync(filePath, "utf8");
  cachedSmartAttestations[file.replace(".json", "")] = JSON.parse(fileData);
});

// Parse chain explorer mapping from chainList
const chainExplorers: { [chainId: number]: string } = {};
for (const chain of require("./chainList.json")) {
  if (chain.explorers && chain.explorers.length > 0) {
    chainExplorers[chain.chainId] = chain.explorers[0];
  }
}

async function smartFetchAttestations(
  name: string,
  url: string,
  query: any,
  variables: any
): Promise<RawAttestation[]> {
  if (
    cachedSmartAttestations[name] &&
    cachedSmartAttestations[name].length &&
    smartAttestationStarted.has(name)
  )
    return cachedSmartAttestations[name];
  if (!cachedSmartAttestations[name]) cachedSmartAttestations[name] = [];

  smartAttestationStarted.add(name);

  async function fetchAttestations() {
    if (!cachedSmartAttestations[name].length) {
      const { attestations }: { attestations: RawAttestation[] } =
        await request(url, query, variables);

      cachedSmartAttestations[name] = attestations;

      return attestations;
    } else {
      if (!variables.where) variables.where = {};

      // Fetch latest time
      const latestTime = Number(cachedSmartAttestations[name][0].time);
      const latestUid = cachedSmartAttestations[name][0].id;

      variables.where.time = {
        gte: latestTime,
      };

      const { attestations }: { attestations: RawAttestation[] } =
        await request(url, query, variables);

      // console.log(attestations)
      // console.log(latestTime)

      const newAttestations: RawAttestation[] = [];

      for (const a of attestations) {
        if (a.id == latestUid) break;
        newAttestations.push(a);
      }

      for (const a of cachedSmartAttestations[name]) {
        newAttestations.push(a);
      }

      cachedSmartAttestations[name] = newAttestations;
      fs.writeFileSync(
        `${ATTESTATION_CACHE_DIR}/${name}.json`,
        JSON.stringify(newAttestations, null, 2)
      );

      return newAttestations;
    }
  }

  await fetchAttestations();
  setInterval(() => fetchAttestations().catch(console.error), 10_000);

  return cachedSmartAttestations[name];
}

// Save metadata cache to file
function saveMetadataCacheToFile(url: string, data: any) {
  const hash = url.split("/").pop();
  if (!hash) return;

  const filePath = path.join(PROJECT_CACHE_DIR, `${hash}.json`);
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
  let parts = url.split("/");
  let ipfsHash = parts[parts.length - 1];

  const cachedMetadata = metadataCache.get("ipfs-" + ipfsHash);
  if (cachedMetadata) {
    return cachedMetadata;
  }

  try {
    // Replace restrictive host
    let newUrl = url.replace(
      "https://gateway.pinata.cloud",
      "https://upnode-internal-dev.quicknode-ipfs.com"
    );

    const response = await axios.get(newUrl);
    const data = response.data;
    metadataCache.set("ipfs-" + ipfsHash, data);
    saveMetadataCacheToFile(url, data); // Save cache to file after setting new data
    return data;
  } catch (error) {
    console.error(`Error fetching metadata from ${url}:`, error);
    return null;
  }
}

async function fetchSnapshot2ProjectRefUid() {
  try {
    const result: { [snapshotId: string]: string } = {};

    const attestations = await smartFetchAttestations(
      "metadataSnapshots",
      url,
      query,
      variables
    );

    attestations.sort((a, b) => b.time - a.time);

    for (const attestation of attestations) {
      const parsedData = parseDecodedDataJson(attestation.decodedDataJson);
      const projectRefUID = parsedData["projectRefUID"];
      result[attestation.id] = projectRefUID;
    }

    return result;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
}

// Function to fetch and process data
async function fetchMGProfiles(fids: number[]) {
  const BATCH_SIZE = 100;

  const profileMap: { [fid: number]: MetricsGardenProfile } = {};
  const uncachedFids: number[] = [];

  for (const fid of fids) {
    const cacheKey = "metricsGardenProfile-" + fid;
    const cachedData = slowCache.get(cacheKey);

    if (cachedData) {
      profileMap[fid] = cachedData as MetricsGardenProfile;
    } else {
      uncachedFids.push(fid);
    }
  }

  if (uncachedFids.length > 0) {
    for (let i = 0; i < uncachedFids.length; i += BATCH_SIZE) {
      const usersResponse = await axios.get(
        "https://api.neynar.com/v2/farcaster/user/bulk",
        {
          params: {
            fids: uncachedFids.slice(i, i + BATCH_SIZE).join(","),
          },
          headers: {
            api_key: process.env.NEYNAR_API_KEY,
          },
        }
      );

      for (const user of usersResponse.data.users) {
        profileMap[user.fid] = {
          username: user.username,
          displayName: user.display_name,
          pfpUrl: user.pfp_url,
        };

        const cacheKey = "metricsGardenProfile-" + user.fid;
        slowCache.set(cacheKey, profileMap[user.fid]);
      }
    }
  }

  return profileMap;
}

async function fetchMG(): Promise<MetricsGarden[]> {
  const cacheKey = "metricsGarden";
  const cachedData = mainCache.get(cacheKey);

  if (cachedData) {
    return cachedData as MetricsGarden[];
  }

  try {
    const attestations = await smartFetchAttestations(
      "metricsGardenReview",
      url,
      query,
      variablesMG
    );

    attestations.sort((a, b) => b.time - a.time);

    const result: MetricsGarden[] = [];
    const fids: Set<number> = new Set();

    // Process fid number of each attestation for profile fetching
    for (const attestation of attestations) {
      const parsedData = parseDecodedDataJson(attestation.decodedDataJson);
      const projectRefUid = parsedData["projectRegUID"];
      const metadataUrl = parsedData["metadataurl"];

      const body = await fetchMetadata(metadataUrl);

      if (!body) {
        continue;
      }

      const fid = body.reviewer?.userFID || body.userFid;
      if (!fid) continue;

      fids.add(fid);
    }

    const profiles: { [fid: number]: MetricsGardenProfile } =
      await fetchMGProfiles(Array.from(fids));

    // Process each attestation
    for (const attestation of attestations) {
      const parsedData = parseDecodedDataJson(attestation.decodedDataJson);
      const projectRefUid = parsedData["projectRegUID"];
      const metadataUrl = parsedData["metadataurl"];

      const body = await fetchMetadata(metadataUrl);

      if (!body) {
        continue;
      }

      const fid = body.reviewer?.userFID || body.userFid;
      if (!fid) continue;

      if (body.impactAttestations) {
        result.push({
          id: attestation.id,
          impactAttestations: body.impactAttestations,
          comment:
            body.impactAttestations.find((x: any) => x.name == "Text Review")
              ?.value || "",
          projectRefUid,
          fid: body.reviewer.userFID,
          ethAddress: body.reviewer.ethAddress,
          profile: profiles[body.reviewer.userFID],
          time: attestation.time,
        });
      } else if (body.data) {
        result.push({
          id: attestation.id,
          impactAttestations: [
            {
              name: "Feeling if didnt exist",
              type: "numeric",
              value: parseInt(body.data.feeling_if_didnt_exist),
            },
            {
              name: "Text Review",
              type: "string",
              value: body.data.explaination,
            },
          ],
          comment: body.data.explaination,
          projectRefUid,
          fid: body.userFid,
          ethAddress: body.ethAddress,
          profile: profiles[body.userFid],
          time: attestation.time,
        });
      }
    }

    mainCache.set(cacheKey, result);
    return result;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
}

function fetchMGFromCache(): MetricsGarden[] {
  const cacheKey = "metricsGarden";
  const cachedData = metadataCache.get(cacheKey);

  fetchMG()
    .then((data) => {
      metadataCache.set(cacheKey, data);
    })
    .catch((error) => {
      console.error("Error fetching MG:", error);
      throw error;
    });

  return (cachedData || []) as MetricsGarden[];
}

// Function to fetch and process data
async function fetchAndProcessData(
  round: number
): Promise<ProcessedAttestation[]> {
  const cacheKey = "attestations" + (round ? "Round" + round : "");
  const cachedData = mainCache.get(cacheKey);

  if (cachedData) {
    return cachedData as ProcessedAttestation[];
  }

  const submissions = await fetchAndProcessRoundSubmissions(round);

  try {
    const attestations = await smartFetchAttestations(
      "projectMetadataSnapshots",
      url,
      query,
      variables
    );

    attestations.sort((a, b) => b.time - a.time);

    // console.log(attestations.slice(0,10))

    // Map to store the latest attestation for each projectRefUID
    const latestAttestationsMap: { [key: string]: any } = {};
    const allAttestationsMap: { [key: string]: any[] } = {};

    // Process each attestation
    for (const attestation of attestations) {
      const parsedData = parseDecodedDataJson(attestation.decodedDataJson);
      const projectRefUID = parsedData["projectRefUID"];
      const metadataUrl = parsedData["metadataUrl"];

      // Filter only submitted to current round for time saving
      if (!submissions[0].has(projectRefUID)) continue;
      // if (!submissions[1].has(attestation.id)) continue; // Disable for now because metadataSnapshotRefUID is not available

      const body = await fetchMetadata(metadataUrl);

      if (!body) {
        continue;
      }

      if (!allAttestationsMap[projectRefUID]) {
        allAttestationsMap[projectRefUID] = [];
      }

      allAttestationsMap[projectRefUID].push({
        ...attestation,
        parsedData,
        body,
        applicationId: submissions[0].get(projectRefUID),
      });

      if (
        !latestAttestationsMap[projectRefUID] ||
        attestation.time > latestAttestationsMap[projectRefUID].time
      ) {
        latestAttestationsMap[projectRefUID] = {
          ...attestation,
          parsedData,
          body,
          applicationId: submissions[0].get(projectRefUID),
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

async function fetchAndProcessRoundSubmissions(
  round: number
): Promise<[Map<string, string>, Set<string>]> {
  const cacheKey =
    "attestationsRoundSubmissions" + (round ? "Round" + round : "");
  const cachedData = mainCache.get(cacheKey);

  if (cachedData) {
    return cachedData as [Map<string, string>, Set<string>];
  }

  const snapshotProjectRefUid = await fetchSnapshot2ProjectRefUid();

  const projectRefUIDs: Map<string, string> = new Map();
  const metadataSnapshotUIDs: Set<string> = new Set();

  try {
    const attestations = await smartFetchAttestations(
      "projectSubmissions",
      url,
      query,
      variablesR4
    );

    attestations.sort((a, b) => b.time - a.time);

    // Process each attestation
    for (const attestation of attestations) {
      const parsedData = parseDecodedDataJson(attestation.decodedDataJson);

      if (parsedData.round == ROUND_SLUG_MAPPING[round] || !round) {
        // console.log('proj', attestation.refUID)
        // console.log('meta', parsedData.metadataSnapshotRefUID)

        const projectRefUID =
          snapshotProjectRefUid[parsedData.metadataSnapshotRefUID] ||
          attestation.refUID;

        if (!projectRefUID) continue;

        if (!projectRefUIDs.has(projectRefUID)) {
          projectRefUIDs.set(projectRefUID, attestation.id);
          applicationRound[attestation.id] = parsedData.round;
        }

        if (
          parsedData.metadataSnapshotRefUID &&
          parsedData.metadataSnapshotRefUID !=
            "0x0000000000000000000000000000000000000000000000000000000000000000"
        ) {
          metadataSnapshotUIDs.add(parsedData.metadataSnapshotRefUID);
        }
      }
    }

    mainCache.set(cacheKey, [projectRefUIDs, metadataSnapshotUIDs]);
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }

  try {
    const attestations = await smartFetchAttestations(
      "projectApplications",
      url,
      query,
      variablesApplication
    );

    attestations.sort((a, b) => b.time - a.time);

    const projectRefUIDs2: Set<string> = new Set();

    // Process each attestation
    for (const attestation of attestations) {
      const projectRefUid = attestation.refUID;
      const parsedData = parseDecodedDataJson(attestation.decodedDataJson);

      if (parseInt(parsedData.round) == round || !round) {
        if (!projectRefUIDs2.has(projectRefUid)) {
          const metadata = await fetchMetadata(parsedData.metadataUrl);
          applicationData[projectRefUid] = applicationData[projectRefUid] ?? {};
          applicationData[projectRefUid][parsedData.round] = metadata;
          projectRefUIDs2.add(projectRefUid);
        }
      }

      if (!projectApplications[projectRefUid])
        projectApplications[projectRefUid] = new Set();
      projectApplications[projectRefUid].add(attestation.id);
    }

    mainCache.set(cacheKey, [projectRefUIDs, metadataSnapshotUIDs]);
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }

  return [projectRefUIDs, metadataSnapshotUIDs];
}

function getPrelimResult(projectRefUid: string): string {
  for (const applicationId of projectApplications[projectRefUid]) {
    const project = eligibility.find(
      (x: any) => x.applicationId == applicationId
    );

    if (!project) continue;

    if (project.status == "pass") return "Keep";
    if (project.status == "fail") return "Remove";
  }

  return "#N/A";
}

function getCharmverseLink(applicationId: string): string | undefined {
  const project = eligibility.find(
    (x: any) => x.applicationId == applicationId
  );
  return project?.charmverseLink;
}

function projectReward(applicationId: string, round: number) {
  const data =
    round == 7 ? rewardDataRound7 : round == 8 ? rewardDataRound8 : rewardData;

  const index = data.findIndex((x: any) => x.application_id == applicationId);

  if (index == -1) return {};

  return {
    totalOP: data[index].final_score,
    rank: index + 1,
  };
}

async function fetchProjects(round: number): Promise<ProjectMetadata[]> {
  const cacheKey = "projects" + (round ? "Round" + round : round);
  const cachedData = mainCache.get(cacheKey);

  if (cachedData) {
    return cachedData as ProjectMetadata[];
  }

  const attestations = await fetchAndProcessData(round);
  const comments = fetchMGFromCache();

  let projects: ProjectMetadata[] = attestations.map((attestation) => {
    const projectApplicationDataUpper =
      applicationData[attestation.parsedData.projectRefUID];
    const projectApplicationData =
      projectApplicationDataUpper && projectApplicationDataUpper[round];

    const filteredComments = comments.filter(
      (comment) => comment.projectRefUid == attestation.parsedData.projectRefUID
    );
    const hasStar = filteredComments.filter((comment) =>
      comment.impactAttestations.find((x) => x.name == "Likely to Recommend")
    );
    const star =
      hasStar.length == 0
        ? 0
        : hasStar.reduce(
            (acc, curr) =>
              acc +
              (curr.impactAttestations.find(
                (x) => x.name == "Likely to Recommend"
              )!.value || 0),
            0
          ) / hasStar.length;

    const impactCategory = [
      attestation.parsedData.category,
      projectApplicationData?.category ??
        categoryR5[attestation.parsedData.projectRefUID],
    ].filter((x) => x);

    return {
      id: attestation.parsedData.projectRefUID,
      metadataId: attestation.id,
      applicationId: attestation.applicationId,
      name: attestation.parsedData.name,
      displayName: attestation.parsedData.name,
      description: attestation.body?.description || "",
      bio: attestation.body?.description || "",
      address: attestation.parsedData.farcasterID.hex,
      bannerImageUrl:
        attestation.body?.projectCoverImageUrl ||
        attestation.body?.proejctCoverImageUrl ||
        "",
      profileImageUrl: attestation.body?.projectAvatarUrl || "",
      impactCategory,
      primaryCategory: impactCategory[impactCategory.length - 1],
      recategorization: attestation.parsedData.category,
      prelimResult: getPrelimResult(attestation.parsedData.projectRefUID),
      reportReason: "",
      includedInBallots: 0,
      isOss: metrics[attestation.parsedData.projectRefUID]
        ? metrics[attestation.parsedData.projectRefUID][0]?.is_oss
        : undefined,

      metricsGarden: {
        reviewerCount: filteredComments.length,
        star,
      },

      ...projectReward(attestation.parsedData.projectRefUID, round),
    };
  });

  projects = projects.filter((project) => !TEST_PROJECTS.includes(project.id));

  // projects = projects.filter(project => farcasterCommentThreads[project.id])
  // projects = projects.sort((a, b) => (b.totalOP || 0) - (a.totalOP || 0))

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
    case "foundation-mission":
      return ["Foundation Mission", "OP"];
    case "token-house-mission":
      return ["Token House Mission", "OP"];
    case "retro-funding":
      return ["Retro Funding", "OP"];
    default:
      return [grantType, "USD"];
  }
}

function etherscanUrl(address: string, chainId: number): string {
  return `${chainExplorers[chainId]}/address/${address}`;
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

async function fetchAgoraProject(id: string) {
  try {
    const cacheKey = "project-agora-" + id;
    const cachedData = slowCache.get(cacheKey);

    if (cachedData) {
      return cachedData;
    }

    const response = await axios.get(
      `https://vote.optimism.io/api/v1/retrofunding/rounds/${applicationRound[id]}/projects/${id}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.AGORA_API_KEY}`,
        },
      }
    );

    return response.data;
  } catch (err) {
    return undefined;
  }
}

function decodeAgoraProjectApplication(
  data: any,
  round: number
): ProjectApplication | null {
  if (data?.impactStatement) {
    const statement =
      data.impactStatement.statement.create ?? data.impactStatement.statement;
    return {
      category: data.impactStatement.category,
      subcategory: data.impactStatement.subcategory,
      impactStatement: statement,
      round,
    };
  }

  return null;
}

async function fetchProject(id: string, round: number): Promise<Project> {
  const cacheKey = "project-" + id;
  const cachedData = mainCache.get(cacheKey);

  if (cachedData) {
    return cachedData as Project;
  }

  const attestations = await fetchAndProcessData(round);
  const attestation = attestations.find(
    (attestation) =>
      attestation.id === id || attestation.parsedData?.projectRefUID === id
  );
  if (!attestation) {
    throw new Error(`Project not found`);
  }

  // const submissions = await fetchAndProcessRoundSubmissions();

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

    for (const grant of attestation.body.grantsAndFunding.grants || []) {
      const [type, currency] = parseGrantType(grant.grant);
      fundingSources.push({
        type,
        currency,
        amount: hyphenToCapitalize(grant.amount),
        description: grant.details,
        url: grant.link || undefined,
      });
    }

    for (const grant of attestation.body.grantsAndFunding.revenue || []) {
      const [type, currency] = parseGrantType("revenue");
      fundingSources.push({
        type,
        currency,
        amount: hyphenToCapitalize(grant.amount),
        description: grant.details,
      });
    }

    for (const grant of attestation.body.grantsAndFunding.retroFunding || []) {
      const [type, currency] = parseGrantType("retro-funding");
      fundingSources.push({
        type,
        currency,
        amount: hyphenToCapitalize(grant.amount),
        description: grant.details,
      });
    }
  }

  const newAttestationContracts = await fetchContracts(
    attestation.parsedData.projectRefUID
  );

  let attestationContracts =
    attestation.body?.contracts?.map((contract) => ({
      description: contract.address,
      type: contract.chainId.toString(),
      url: etherscanUrl(contract.address, contract.chainId),
    })) || [];

  if (newAttestationContracts.length > 0) {
    attestationContracts = newAttestationContracts.map((contract) => ({
      description: contract.contract_address,
      type: contract.chain_id.toString(),
      url: etherscanUrl(contract.contract_address, contract.chain_id),
    }));
  }

  // const osoProjectContracts = osoContracts[
  //   attestation.parsedData.projectRefUID
  // ].map((contract: any) => ({
  //   description: contract.contract_address,
  //   type: osoChainId(contract.network).toString(),
  //   url: etherscanUrl(contract.contract_address, osoChainId(contract.network)),
  // }));

  const osoProjectContracts = [];

  if (attestation.body?.osoSlug) {
    try {
      const response = await axios.get(
        `https://raw.githubusercontent.com/opensource-observer/oss-directory/main/data/projects/${attestation.body.osoSlug[0].toLowerCase()}/${attestation.body.osoSlug.toLowerCase()}.yaml`
      );
      const data = YAML.parse(response.data);
      const filtered = data.blockchain?.filter(
        (contract: any) => contract.tags.indexOf("contract") != -1
      );
      if (filtered) {
        for (const contract of filtered) {
          for (const network of contract.networks) {
            const chainId = osoChainId(network);
            if (chainId) {
              osoProjectContracts.push({
                description: contract.address,
                type: chainId.toString(),
                url: etherscanUrl(contract.address, chainId),
              });
            }
          }
        }
      }
    } catch (err: any) {
      if (!err.response || err.response.status != 404) {
        console.error(err);
      }
    }
  }

  const projectMetrics = metrics[attestation.parsedData.projectRefUID]
    ? metrics[attestation.parsedData.projectRefUID][0]
    : null;
  const projectMetricsPercent =
    rewardMetrics.find(
      (x: any) => x.application_id == attestation.parsedData.projectRefUID
    ) || projectMetrics;
  const projectMetricsPercentOss =
    rewardMetricsOss.find(
      (x: any) => x.application_id == attestation.parsedData.projectRefUID
    ) || projectMetrics;

  // for (const m of agoraMetrics) {
  //   projectMetricsPercent[m.metric_id] = parseFloat(m.allocations_per_project.find((x: any) => x.project_id == attestation.parsedData.projectRefUID)?.allocation || '0')
  // }

  const agoraBody = await fetchAgoraProject(attestation.applicationId);

  const projectApplicationDataUpper =
    applicationData[attestation.parsedData.projectRefUID];
  const projectApplicationData =
    projectApplicationDataUpper && projectApplicationDataUpper[round];

  const project = {
    id: attestation.parsedData.projectRefUID,
    metadataId: attestation.id,
    applicationId: attestation.applicationId,
    round: applicationRound[attestation.applicationId],
    displayName: attestation.parsedData.name,
    contributionDescription: attestation.body?.description || "",
    impactDescription: "",
    bio: attestation.body?.description || "",
    profile: {
      bannerImageUrl:
        attestation.body?.projectCoverImageUrl ||
        attestation.body?.proejctCoverImageUrl ||
        "",
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
    impactCategory: [
      attestation.parsedData.category,
      projectApplicationData?.category ??
        categoryR5[attestation.parsedData.projectRefUID],
    ].filter((x) => x),
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

    github:
      attestation.body?.github.map((github) =>
        typeof github === "string" ? github : github.url
      ) || [],
    packages:
      attestation.body?.packages.map((p) =>
        typeof p === "string" ? p : p.url
      ) || [],

    osoSlug: attestation.body?.osoSlug || "",
    metrics: projectMetrics,
    metricsPercent: projectMetricsPercent,
    metricsPercentOss: projectMetricsPercentOss,

    charmverseLink: getCharmverseLink(attestation.applicationId),

    attestationBody: attestation.body,
    agoraBody,

    application:
      projectApplicationData ?? decodeAgoraProjectApplication(agoraBody, round),

    ...projectReward(attestation.parsedData.projectRefUID, round),
  };

  mainCache.set(cacheKey, project);

  return project;
}

async function fetchProjectCount(round: number) {
  const cacheKey = "projectCount" + (round ? "Round" + round : "");
  const cachedData = mainCache.get(cacheKey);

  if (cachedData) {
    return cachedData;
  }

  let projects = await fetchProjects(round);
  const eligible = projects.filter((x) => x.prelimResult == "Keep").length;

  // TODO: elibility switch
  // if (round < 6) {
  //   projects = projects.filter(project => project.prelimResult.toLowerCase() == 'keep');
  // }

  const countMap = projects.reduce((result, currentItem) => {
    if (eligible && currentItem.prelimResult.toLowerCase() != "keep") {
      return result;
    }

    const groupKey =
      currentItem.impactCategory[currentItem.impactCategory.length - 1];
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
    eligible,
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
const port = 4204;

// Use CORS middleware
app.use(express.json());
app.use(cors());

// Define the endpoint
app.get("/:round/attestations", async (req, res) => {
  try {
    const attestations = await fetchAndProcessData(parseInt(req.params.round));
    res.json(attestations);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch attestations" });
  }
});

app.get("/:round/projects/count", async (req, res) => {
  try {
    const count = await fetchProjectCount(parseInt(req.params.round));
    res.json(count);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch project count" });
  }
});

app.get("/:round/projects/:id/comments", async (req, res) => {
  try {
    const comments = await fetchProjectComments(req.params.id);
    res.json(comments);
  } catch (error: any) {
    console.error(error);
    if (error.message == "Project not found") {
      res.status(404).json({ error: "Project not found" });
    } else {
      res.status(500).json({ error: "Failed to fetch project" });
    }
  }
});

app.get("/projects/:id", async (req, res) => {
  try {
    const project = await fetchProject(req.params.id, 6);
    res.json(project);
  } catch (error: any) {
    if (error.message == "Project not found") {
      res.status(404).json({ error: "Project not found" });
    } else {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch project" });
    }
  }
});

app.get("/projects/:id/metricsgarden", async (req, res) => {
  try {
    const comments = await fetchMG();
    res.json(comments.filter((x) => x.projectRefUid == req.params.id));
  } catch (error: any) {
    if (error.message == "Project not found") {
      res.status(404).json({ error: "Project not found" });
    } else {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch project metricsgarden" });
    }
  }
});

app.get("/:round/projects", async (req, res) => {
  try {
    const projects = await fetchProjects(parseInt(req.params.round));
    res.json(projects);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch projects" });
  }
});

app.get("/:round/projects/:id", async (req, res) => {
  try {
    const project = await fetchProject(
      req.params.id,
      parseInt(req.params.round)
    );
    res.json(project);
  } catch (error: any) {
    if (error.message == "Project not found") {
      res.status(404).json({ error: "Project not found" });
    } else {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch project" });
    }
  }
});

app.get("/metricsgarden", async (req, res) => {
  try {
    const comments = await fetchMG();

    const skip = parseInt((req.query.skip as string) || "0");
    const limit = parseInt((req.query.limit as string) || "20");

    res.json(comments.slice(skip, skip + limit));
  } catch (error: any) {
    if (error.message == "Project not found") {
      res.status(404).json({ error: "Project not found" });
    } else {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch project metricsgarden" });
    }
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
      return res.status(400).json({
        error: "Reason, Project ID and Turnstile token are required.",
      });
    }

    // Verify Turnstile token
    // const isTokenValid = await verifyTurnstileToken(turnstileToken);

    // if (!isTokenValid) {
    //   return res.status(403).json({ error: 'Invalid Turnstile token.' });
    // }

    // Insert message into PostgreSQL database
    const client = await dbClient();
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
    const client = await dbClient();
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
    const client = await dbClient();
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

for (const round of CURRENT_ROUND) {
  fetchAndProcessData(round);
  setInterval(() => fetchAndProcessData(round), 300_000);
}

setInterval(() => fetchMG(), 300_000);

process.on("unhandledRejection", (reason, promise) => {
  console.trace(reason);
  // Optionally, you can exit the process with a non-zero code
  // process.exit(1);
});

import { config as dotenv } from "dotenv";
dotenv();

import { gql, request } from "graphql-request";
import { dbClient } from "./db";
import { RawAttestation } from "./types/attestations";

// Define the GraphQL endpoint
const url = "https://optimism.easscan.org/graphql";

// Define the query
const query = gql`
  query Attestations($where: AttestationWhereInput, $take: Int) {
    attestations(where: $where, orderBy: { time: asc }, take: $take) {
      id
      decodedDataJson
      time
      refUID
    }
  }
`;

const variables = {
  where: {
    schemaId: {
      equals:
        "0x5560b68760b2ec5a727e6a66e1f9754c307384fe7624ae4e0138c530db14a70b",
    },
    attester: {
      equals: "0xF6872D315CC2E1AfF6abae5dd814fd54755fE97C",
    },
    time: {
      gte: 0,
    },
  },
  take: 2000,
};

let indexing = false;

// Function to parse decodedDataJson
function parseDecodedDataJson(decodedDataJson: string) {
  const decodedData = JSON.parse(decodedDataJson);
  const parsedData: { [key: string]: any } = {};
  decodedData.forEach((item: any) => {
    parsedData[item.name] = item.value.value;
  });
  return parsedData;
}

async function fetchLastIndexedContract() {
  const client = await dbClient();
  try {
    const result = await client.query("SELECT attestation_timestamp FROM contracts ORDER BY attestation_timestamp DESC LIMIT 1");
    if (result.rows.length === 0) {
      return 0;
    }
    return result.rows[0].attestation_timestamp || 0;
  } finally {
    client.release();
  }
}

async function indexContracts() {
  try {
    if (indexing) return;
    indexing = true;

    const lastIndexedTimestamp = await fetchLastIndexedContract();

    variables.where.time.gte = parseInt(lastIndexedTimestamp);
  
    const { attestations }: { attestations: RawAttestation[] } = await request(
      url,
      query,
      variables
    );
  
    for (const a of attestations) {
      const decodedData = parseDecodedDataJson(a.decodedDataJson);
  
      const client = await dbClient();
      try {
        await client.query(
          `INSERT INTO contracts (
            project_uid,
            contract_address,
            chain_id,
            deployer,
            deployment_tx,
            signature,
            verification_chain_id,
            farcaster_id,
            attestation_uid,
            attestation_timestamp
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (project_uid, contract_address, chain_id) DO UPDATE SET
            deployer = EXCLUDED.deployer,
            deployment_tx = EXCLUDED.deployment_tx,
            signature = EXCLUDED.signature,
            verification_chain_id = EXCLUDED.verification_chain_id,
            farcaster_id = EXCLUDED.farcaster_id,
            attestation_uid = EXCLUDED.attestation_uid,
            attestation_timestamp = EXCLUDED.attestation_timestamp`,
          [
            a.refUID,
            decodedData.contract,
            decodedData.chainId,
            decodedData.deployer,
            decodedData.deploymentTx,
            decodedData.signature,
            decodedData.verificationChainId,
            decodedData.farcasterID?.hex ? parseInt(decodedData.farcasterID.hex, 16) : null,
            a.id,
            Number(a.time)
          ]
        );
      } finally {
        client.release();
      }
    }
  } finally {
    indexing = false;
  }
}

export async function fetchContracts(projectUid: string) {
  const client = await dbClient();
  try {
    const result = await client.query(
      `SELECT 
        contract_address,
        chain_id,
        deployer,
        deployment_tx,
        signature,
        verification_chain_id,
        farcaster_id,
        attestation_uid,
        attestation_timestamp
      FROM contracts 
      WHERE project_uid = $1`,
      [projectUid]
    );
    return result.rows;
  } finally {
    client.release();
  }
}

indexContracts();
setInterval(indexContracts, 1000 * 10);

import * as fs from "fs";
import axios from "axios";

interface CharmverseEntry {
  formId: string;
  title: string;
  currentStep: {
    result: string;
  }
  // Other fields can be added if needed
}

interface Attestation {
  id: string;
  parsedData: {
    projectRefUID: string;
    name: string;
  };
  // Other fields can be added if needed
}

interface MatchedEntry {
  charmverseId?: string;
  projectRefUID: string;
  name: string;
  status: string;
}

// Function to read the charmverse.json file
function readCharmverseFile(filePath: string): Promise<CharmverseEntry[]> {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, "utf8", (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(JSON.parse(data));
      }
    });
  });
}

// Function to fetch attestations
async function fetchAttestations(url: string): Promise<Attestation[]> {
  const response = await axios.get(url);
  return response.data;
}

// Function to match charmverse entries with attestations by name
function matchEntries(
  charmverseEntries: CharmverseEntry[],
  attestations: Attestation[]
): MatchedEntry[] {
  const matchedEntries: MatchedEntry[] = [];

  charmverseEntries.forEach((charmverseEntry) => {
    const matchingAttestation = attestations.find(
      (attestation) => attestation.parsedData.name.trim() === charmverseEntry.title.trim()
    );
    if (matchingAttestation) {
      matchedEntries.push({
        charmverseId: charmverseEntry.formId,
        projectRefUID: matchingAttestation.parsedData.projectRefUID,
        name: charmverseEntry.title,
        status: charmverseEntry.currentStep.result,
      });
    } else {
      console.log("Unmatched", charmverseEntry.title)
    }
  });

  return matchedEntries;
}

// Function to merge prelim ineligibility
function prelimIneligiblity(attestations: Attestation[], dup: string[]) {
  const raw = fs.readFileSync("data/ineligible.json", "utf8")
  const ineligible = JSON.parse(raw);
  const matchedEntries: MatchedEntry[] = [];

  console.log('Prelim ineli:', ineligible.length)

  for (const id of ineligible) {
    const matchingAttestation = attestations.find(
      (attestation) => attestation.parsedData.projectRefUID === id
    );

    if (matchingAttestation) {
      if (dup.indexOf(matchingAttestation.parsedData.projectRefUID) == -1) {
        matchedEntries.push({
          projectRefUID: matchingAttestation.parsedData.projectRefUID,
          name: matchingAttestation.parsedData.name.trim(),
          status: "fail",
        });
      }
    } else {
      console.log("Unmatched", id)
    }
  }

  return matchedEntries;
}

// Main function to execute the matching process
async function main() {
  try {
    const charmverseFilePath = "data/charmverse.json";
    const attestationUrl = "https://round4-api-eas.retrolist.app/attestations";

    const charmverseEntries = await readCharmverseFile(charmverseFilePath);
    console.log('Charmverse loaded')
    const attestations = await fetchAttestations(attestationUrl);
    console.log('Attestation loaded')
    const judgeEntries = matchEntries(charmverseEntries, attestations);
    const prelimEntries = prelimIneligiblity(attestations, judgeEntries.map(x => x.projectRefUID))
    const matchedEntries = judgeEntries.concat(prelimEntries)

    // console.log(JSON.stringify(matchedEntries, null, 2));
    console.log("Pass:", matchedEntries.filter(x => x.status == 'pass').length)
    console.log("In Progress:", matchedEntries.filter(x => x.status == 'in_progress').length)
    console.log("Fail:", matchedEntries.filter(x => x.status == 'fail').length)
    console.log("Total:", matchedEntries.length)

    fs.writeFileSync("data/eligibility.json", JSON.stringify(matchedEntries, undefined, 2))
  } catch (error) {
    console.error("Error:", error);
  }
}

main();

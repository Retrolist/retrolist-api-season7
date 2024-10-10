import { AttestationBody } from "./attestationBody";

export interface RawAttestation {
  id: string;
  decodedDataJson: string;
  time: number;
  refUID: string;
}

export interface DecodedData {
  projectRefUID: string;
  farcasterID: {
    type: string
    hex: string
  };
  name: string;
  category: string;
  parentProjectRefUID: string;
  metadataType: number;
  metadataUrl: string;
}

export interface ProcessedAttestation {
  id: string;
  applicationId: string;
  time: number;
  parsedData: DecodedData;
  body: AttestationBody | null;
  revisions: ProcessedAttestationRevision[];
}

export interface ProcessedAttestationRevision {
  id: string;
  time: number;
  parsedData: DecodedData;
  body: AttestationBody | null;
}
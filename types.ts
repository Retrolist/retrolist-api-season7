export interface RawAttestation {
  id: string;
  decodedDataJson: string;
  time: number;
}

export interface DecodedData {
  projectRefUID: string;
  farcasterID: string;
  name: string;
  category: string;
  parentProjectRefUID: string;
  metadataType: number;
  metadataUrl: string;
}

export interface AttestationBody {
  [key: string]: any;
}

export interface ProcessedAttestation {
  id: string;
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
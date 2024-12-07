
export interface MetricaGardenImpact {
  name: string
  type: string
  value: number
}

export interface MetricsGardenProfile {
  username: string
  displayName: string
  pfpUrl: string
}

export interface MetricsGarden {
  id: string
  impactAttestations: MetricaGardenImpact[]
  comment: string
  projectRefUid: string
  fid: number
  ethAddress: string
  profile: MetricsGardenProfile
  time: number
}
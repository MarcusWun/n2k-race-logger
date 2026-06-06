export interface PolarData {
  tws: number[];
  twa: number[];
  speeds: number[][]; // speeds[twsIndex][twaIndex]
}

export interface BoatProfile {
  id: number;
  name: string;
  hullType: string;
  polarData: PolarData;
  createdAt: string;
}

export interface PolarPerformance {
  percentPolar: number | null;
  targetSpeed: number | null;
  actualSpeed: number | null;
}

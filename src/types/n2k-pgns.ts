export interface PGNData {
  pgn: number;
  fields: Record<string, string | number>;
  timestamp: string;
  raw?: string;
}

export interface N2KPoint {
  id?: number;
  raceId: number;
  timestamp: string;
  pgn: number;
  data: string;
}

export const DEFAULT_PGN_FILTER: number[] = [
  128259, // Speed - Water Referenced
  129025, // Position - Rapid Update
  129026, // COG & SOG - Rapid Update
  129029, // GNSS Position Data
  127250, // Vessel Heading
  130306, // Wind Data
  130310, // Environmental Parameters
  127257, // Attitude
  129284, // Navigation Data
];

export const PGN_NAMES: Record<number, string> = {
  128259: 'Speed - Water Referenced',
  129025: 'Position - Rapid Update',
  129026: 'COG & SOG - Rapid Update',
  129029: 'GNSS Position Data',
  127250: 'Vessel Heading',
  130306: 'Wind Data',
  130310: 'Environmental Parameters',
  127257: 'Attitude',
  129284: 'Navigation Data',
};

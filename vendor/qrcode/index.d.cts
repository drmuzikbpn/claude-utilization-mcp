/** Types for the vendored QRCode matrix generator (CLI-only, §23.48). */
declare class QRCode {
  /** `typeNumber` < 1 picks the smallest version that fits; `errorCorrectLevel` from QRErrorCorrectLevel. */
  constructor(typeNumber: number, errorCorrectLevel: number);
  addData(data: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}
export = QRCode;

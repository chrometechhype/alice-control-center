declare module 'adm-zip' {
  interface ZipEntry {
    entryName: string;
    isDirectory: boolean;
    header: { size: number };
  }

  export default class AdmZip {
    constructor(file?: string | Buffer);
    getEntries(): ZipEntry[];
    extractAllTo(target: string, overwrite?: boolean): void;
  }
}

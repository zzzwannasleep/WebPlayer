export type ByteSourceSlice = {
  arrayBuffer(): Promise<ArrayBuffer>;
};

export type ByteSource = {
  size: number;
  slice(start?: number, end?: number): ByteSourceSlice;
  arrayBuffer(): Promise<ArrayBuffer>;
  abort?: () => void;
};


declare module "utif" {
  type Ifd = {
    width: number;
    height: number;
    data?: Uint8Array;
    [key: string]: unknown;
  };
  export function decode(buffer: ArrayBuffer): Ifd[];
  export function decodeImage(buffer: ArrayBuffer, ifd: Ifd): void;
  export function toRGBA8(ifd: Ifd): Uint8Array;
}

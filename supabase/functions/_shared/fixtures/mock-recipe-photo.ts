// What `AI_IMAGE_MODEL=mock` answers (spec 6.11): a small fixed JPEG, a plain grey 64×48 baseline
// image. Kept as bytes in a module, not a .jpg, so the Edge Function bundle always carries it.

const SOI = [0xff, 0xd8];
const APP0_JFIF = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
/** One quantization table, every entry 1. */
const DQT = [0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array(64).fill(0x01)];
/** Baseline, 8-bit, 48 rows × 64 columns, one component (grey), no subsampling, table 0. */
const SOF0 = [0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x30, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00];
/** A Huffman table (class/id `tableId`) with one 1-bit code, "0", for symbol 0. */
const dht = (tableId: number) => [0xff, 0xc4, 0x00, 0x14, tableId, 0x01, ...new Array(15).fill(0x00), 0x00];
const SOS = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
/** 48 blocks, each "0" (DC unchanged: mid grey) then "0" (end of block): 96 zero bits. */
const SCAN = new Array(12).fill(0x00);
const EOI = [0xff, 0xd9];

export const MOCK_RECIPE_PHOTO_JPEG: Uint8Array = Uint8Array.from([...SOI, ...APP0_JFIF, ...DQT, ...SOF0, ...dht(0x00), ...dht(0x10), ...SOS, ...SCAN, ...EOI]);

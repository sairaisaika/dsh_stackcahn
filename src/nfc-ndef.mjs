// Layer 1 decoding of NFC Forum Type 2 tag memory (NTAG, Ultralight): the
// capability container and the NDEF message inside the TLV area. Decoding only;
// what a record means is for DSH. Raw bytes are always returned alongside.

// URI identifier codes, NFC Forum URI Record Type Definition, table 3.
const URI_PREFIXES = ['', 'http://www.', 'https://www.', 'http://', 'https://', 'tel:', 'mailto:',
  'ftp://anonymous:anonymous@', 'ftp://ftp.', 'ftps://', 'sftp://', 'smb://', 'nfs://', 'ftp://', 'dav://',
  'news:', 'telnet://', 'imap:', 'rtsp://', 'urn:', 'pop:', 'sip:', 'sips:', 'tftp:', 'btspp://',
  'btl2cap://', 'btgoep://', 'tcpobex://', 'irdaobex://', 'file://', 'urn:epc:id:', 'urn:epc:tag:',
  'urn:epc:pat:', 'urn:epc:raw:', 'urn:epc:', 'urn:nfc:'];

/** Capability container (page 3): magic 0xE1, mapping version, data area size, access. */
export function parseCapabilityContainer(page3) {
  if (!Buffer.isBuffer(page3) || page3.length < 4 || page3[0] !== 0xe1) return null;
  return { version: `${page3[1] >> 4}.${page3[1] & 15}`, dataAreaBytes: page3[2] * 8,
    readAccess: page3[3] >> 4, writeAccess: page3[3] & 15 };
}

// UTF-16 text: big-endian unless a byte order mark says otherwise.
function utf16(body) {
  if (body.length % 2) return '';
  if (body[0] === 0xff && body[1] === 0xfe) return body.subarray(2).toString('utf16le');
  const swapped = Buffer.from(body.subarray(body[0] === 0xfe && body[1] === 0xff ? 2 : 0));
  return swapped.swap16().toString('utf16le');
}

function decodeRecord(record) {
  const type = record.type.toString('latin1');
  if (record.tnf === 1 && type === 'T' && record.payload.length >= 1) {
    const status = record.payload[0], langLength = status & 0x3f;
    if (1 + langLength <= record.payload.length) {
      const body = record.payload.subarray(1 + langLength);
      return { text: status & 0x80 ? utf16(body) : body.toString('utf8'),
        language: record.payload.subarray(1, 1 + langLength).toString('latin1') };
    }
  }
  if (record.tnf === 1 && type === 'U' && record.payload.length >= 1)
    return { uri: (URI_PREFIXES[record.payload[0]] ?? '') + record.payload.subarray(1).toString('utf8') };
  if (record.tnf === 2) return { mediaType: type };
  if (record.tnf === 4) return { externalType: type };
  return {};
}

/** NDEF records from an NDEF message; complete=false when the bytes ran out. */
export function parseNdefMessage(message) {
  const records = [];
  let at = 0;
  while (at < message.length) {
    const header = message[at++];
    const shortRecord = header & 0x10, hasId = header & 0x08;
    if (at + 1 > message.length) return { complete: false, records };
    const typeLength = message[at++];
    let payloadLength;
    if (shortRecord) { if (at + 1 > message.length) return { complete: false, records }; payloadLength = message[at++]; }
    else { if (at + 4 > message.length) return { complete: false, records }; payloadLength = message.readUInt32BE(at); at += 4; }
    let idLength = 0;
    if (hasId) { if (at + 1 > message.length) return { complete: false, records }; idLength = message[at++]; }
    if (at + typeLength + idLength + payloadLength > message.length) return { complete: false, records };
    const type = message.subarray(at, at += typeLength);
    const id = message.subarray(at, at += idLength);
    const payload = message.subarray(at, at += payloadLength);
    const record = { tnf: header & 0x07, type, payload, chunked: !!(header & 0x20) };
    records.push({ tnf: record.tnf, typeHex: type.toString('hex'), type: type.toString('latin1'),
      ...(idLength ? { idHex: id.toString('hex') } : {}), payloadHex: payload.toString('hex'),
      ...(record.chunked ? { chunked: true } : {}), ...decodeRecord(record) });
    if (header & 0x40) return { complete: true, records };   // Message end
  }
  return { complete: false, records };
}

/** The TLV area that starts at page 4: the first NDEF message TLV, decoded. */
export function parseType2Tlvs(area) {
  let at = 0;
  while (at < area.length) {
    const tag = area[at++];
    if (tag === 0x00) continue;                 // NULL
    if (tag === 0xfe) return { ndef: null, terminated: true };
    if (at >= area.length) break;
    let length = area[at++];
    if (length === 0xff) { if (at + 2 > area.length) break; length = area.readUInt16BE(at); at += 2; }
    if (tag === 0x03) {
      const message = area.subarray(at, at + length);
      if (message.length < length) return { ndef: { lengthBytes: length, ...parseNdefMessage(message), complete: false } };
      return { ndef: { lengthBytes: length, ...parseNdefMessage(message) } };
    }
    at += length;                               // Lock control, memory control, proprietary
  }
  return { ndef: null, terminated: false };
}

const coded = code => Object.assign(new Error(code), { code });
/** Read a Type 2 tag through readPages(page, count) (≤ 64 pages per call; resolves {card, dataHex}).
 * With page/count: exactly those pages. Without: pages 0..3, then the NDEF area the capability
 * container announces, decoded. Every chunk must come from the same card. */
export async function readType2(readPages, { page, count } = {}) {
  let card = null, pollStats;
  const read = async (from, total) => {
    const parts = [];
    for (let done = 0; done < total; done += 64) {
      const part = await readPages(from + done, Math.min(64, total - done));
      if (card && part.card.uid !== card.uid) throw coded('nfc-card-changed');
      card = part.card; pollStats = part.pollStats ?? pollStats; parts.push(Buffer.from(part.dataHex, 'hex'));
    }
    return Buffer.concat(parts);
  };
  if (page !== undefined || count !== undefined) {
    const first = page ?? 0, total = count ?? 4;
    if (!Number.isInteger(first) || !Number.isInteger(total) || first < 0 || total < 1 || first + total > 256) throw coded('nfc-invalid');
    const data = await read(first, total);
    return { version: 1, card, page: first, count: total, dataHex: data.toString('hex'), ...(pollStats ? { pollStats } : {}) };
  }
  const header = await read(0, 4);
  const capabilityContainer = parseCapabilityContainer(header.subarray(12, 16));
  if (!capabilityContainer) throw coded('nfc-no-ndef');
  const pages = Math.min(Math.ceil(capabilityContainer.dataAreaBytes / 4), 252);
  const area = pages ? await read(4, pages) : Buffer.alloc(0);
  return { version: 1, card, page: 0, count: 4 + pages, dataHex: Buffer.concat([header, area]).toString('hex'),
    capabilityContainer, ndef: parseType2Tlvs(area).ndef, ...(pollStats ? { pollStats } : {}) };
}

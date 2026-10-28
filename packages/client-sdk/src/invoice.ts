/**
 * Invoice decoding for intent construction: RGB invoices in the rgb-invoicing
 * v0.11 grammar
 * `rgb:<contract|~>/<schema|~>/<state|~>/<beneficiary>?expiry=&endpoints=`
 * (asset id, amount, beneficiary kind, transports). In this grammar a witness
 * beneficiary is a `wvout:` recipient id, not a plain address; full RGB
 * validation is explicitly out of scope (design doc).
 */
export class InvoiceDecodeError extends Error {
  constructor(detail: string) {
    super(`invalid invoice: ${detail}`);
    this.name = 'InvoiceDecodeError';
  }
}

export interface RgbInvoice {
  /** Full asset id (`rgb:…`), or null for asset-agnostic invoices. */
  assetId: string | null;
  /** Schema id segment, or null when omitted. */
  schema: string | null;
  /** Fungible amount, or null (omitted / non-fungible state). */
  amount: bigint | null;
  /** Raw assignment-state segment when present and non-numeric. */
  assignmentRaw: string | null;
  /**
   * Chain-qualified beneficiary — exactly the `recipientId` the gateway's
   * send-asset prepare expects (e.g. `bcrt:utxob:…` or `bcrt:wvout:…`).
   */
  recipientId: string;
  /** blind = utxob seal on an existing UTXO; witness = wvout, paid by a new output. */
  beneficiaryKind: 'blind' | 'witness' | 'unknown';
  /** Chain prefix of the beneficiary (bc, tb, bcrt, …). */
  chain: string | null;
  /** Consignment transport endpoints from the `endpoints` query param. */
  transportEndpoints: string[];
  /** Unix-seconds expiry from the `expiry` query param. */
  expiryTimestamp: number | null;
  assignmentName: string | null;
}

const OMITTED = '~';

function percentDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function decodeRgbInvoice(invoice: string): RgbInvoice {
  if (!invoice.startsWith('rgb:')) throw new InvoiceDecodeError('missing rgb: scheme');
  const body = invoice.slice('rgb:'.length);
  const queryIndex = body.indexOf('?');
  const path = queryIndex === -1 ? body : body.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : body.slice(queryIndex + 1);

  const segments = path.split('/');
  if (segments.length !== 4) {
    throw new InvoiceDecodeError(
      `expected contract/schema/state/beneficiary, got ${segments.length} segment(s)`,
    );
  }
  const [contractSeg, schemaSeg, stateSeg, beneficiarySeg] = segments as [
    string,
    string,
    string,
    string,
  ];
  if (beneficiarySeg === '') throw new InvoiceDecodeError('empty beneficiary');

  const assetId = contractSeg === OMITTED ? null : `rgb:${contractSeg}`;
  const schema = schemaSeg === OMITTED ? null : schemaSeg;
  let amount: bigint | null = null;
  let assignmentRaw: string | null = null;
  if (stateSeg !== OMITTED) {
    if (/^\d+$/.test(stateSeg)) amount = BigInt(stateSeg);
    else assignmentRaw = stateSeg;
  }

  const beneficiaryMatch = /^([a-z0-9]+):(utxob|wvout):(.+)$/.exec(beneficiarySeg);
  const chain = beneficiaryMatch === null ? null : (beneficiaryMatch[1] as string);
  const beneficiaryKind =
    beneficiaryMatch === null ? 'unknown' : beneficiaryMatch[2] === 'utxob' ? 'blind' : 'witness';

  let transportEndpoints: string[] = [];
  let expiryTimestamp: number | null = null;
  let assignmentName: string | null = null;
  if (query !== '') {
    for (const pair of query.split('&')) {
      const eq = pair.indexOf('=');
      if (eq === -1) throw new InvoiceDecodeError(`malformed query parameter: ${pair}`);
      const key = percentDecode(pair.slice(0, eq));
      const value = percentDecode(pair.slice(eq + 1));
      if (key === 'endpoints') {
        transportEndpoints = value.split(',').filter((endpoint) => endpoint !== '');
      } else if (key === 'expiry') {
        if (!/^\d+$/.test(value)) throw new InvoiceDecodeError(`invalid expiry: ${value}`);
        expiryTimestamp = Number(value);
      } else if (key === 'assignment_name') {
        assignmentName = value;
      }
    }
  }

  return {
    assetId,
    schema,
    amount,
    assignmentRaw,
    recipientId: beneficiarySeg,
    beneficiaryKind,
    chain,
    transportEndpoints,
    expiryTimestamp,
    assignmentName,
  };
}

/**
 * Invoice decoding: RGB invoices in the rgb-invoicing v0.11 grammar,
 * including the real invoice rgb-lib generated in the parity fixture.
 */
import { describe, expect, it } from 'vitest';
import { decodeRgbInvoice, InvoiceDecodeError } from '../src/invoice.js';
import { fixture } from './helpers.js';

describe('decodeRgbInvoice', () => {
  it('decodes the real rgb-lib witness invoice from the parity fixture', () => {
    const invoice = decodeRgbInvoice(fixture.witnessReceive.invoice);
    expect(invoice.assetId).toBeNull();
    expect(invoice.schema).toBeNull();
    expect(invoice.amount).toBeNull();
    expect(invoice.recipientId).toBe(fixture.witnessReceive.recipientId);
    expect(invoice.beneficiaryKind).toBe('witness');
    expect(invoice.chain).toBe('bcrt');
    expect(invoice.expiryTimestamp).toBe(fixture.witnessReceive.expirationTimestamp);
    expect(invoice.transportEndpoints).toEqual(['rpc://localhost:3000/json-rpc']);
  });

  it('decodes an asset-specific blind invoice with amount and endpoints', () => {
    const invoice = decodeRgbInvoice(
      'rgb:erRCLIhl-nBu1DdF-M8YCRNH-Y3rB0W3-hLZH1DP-1AY9zpQ/RGB20Fixed/100/bcrt:utxob:4vm1CX2Z-K8hMo59-e7dgGBS-Jka7mYn-Xe~yP85-yUiHHxr-aVlYa?expiry=1700000000&endpoints=rpc://proxy-a/json-rpc,rpcs://proxy-b/json-rpc',
    );
    expect(invoice.assetId).toBe('rgb:erRCLIhl-nBu1DdF-M8YCRNH-Y3rB0W3-hLZH1DP-1AY9zpQ');
    expect(invoice.schema).toBe('RGB20Fixed');
    expect(invoice.amount).toBe(100n);
    expect(invoice.beneficiaryKind).toBe('blind');
    expect(invoice.recipientId).toBe(
      'bcrt:utxob:4vm1CX2Z-K8hMo59-e7dgGBS-Jka7mYn-Xe~yP85-yUiHHxr-aVlYa',
    );
    expect(invoice.expiryTimestamp).toBe(1700000000);
    expect(invoice.transportEndpoints).toEqual([
      'rpc://proxy-a/json-rpc',
      'rpcs://proxy-b/json-rpc',
    ]);
  });

  it('keeps non-numeric assignment state raw and parses assignment_name', () => {
    const invoice = decodeRgbInvoice(
      'rgb:3NoxsLum-cRPebTV-gTZY8qY-KS20lx7-OqgtBls-t7muan4/~/BF/bc:utxob:4vm1CX2Z-K8hMo59-e7dgGBS-Jka7mYn-Xe~yP85-yUiHHxr-aVlYa?assignment_name=assetOwner',
    );
    expect(invoice.amount).toBeNull();
    expect(invoice.assignmentRaw).toBe('BF');
    expect(invoice.assignmentName).toBe('assetOwner');
    expect(invoice.chain).toBe('bc');
  });

  it('rejects malformed invoices', () => {
    expect(() => decodeRgbInvoice('rgbx:~/~/~/bcrt:utxob:x')).toThrow(InvoiceDecodeError);
    expect(() => decodeRgbInvoice('rgb:~/~/bcrt:utxob:x')).toThrow(InvoiceDecodeError);
    expect(() => decodeRgbInvoice('rgb:~/~/~/')).toThrow(InvoiceDecodeError);
    expect(() => decodeRgbInvoice('rgb:~/~/~/bcrt:utxob:x?expiry=soon')).toThrow(
      InvoiceDecodeError,
    );
    expect(() => decodeRgbInvoice('rgb:~/~/~/bcrt:utxob:x?flag')).toThrow(InvoiceDecodeError);
  });
});

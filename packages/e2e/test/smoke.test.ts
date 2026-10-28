import { describe, expect, it } from 'vitest';
import { E2E_NAME } from '../src/index.js';

describe('e2e package smoke', () => {
  it('imports resolve and exports are present', () => {
    expect(E2E_NAME).toBe('@utexo/lightsdk-gateway-e2e');
  });
});

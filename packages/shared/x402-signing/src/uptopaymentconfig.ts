export interface UptoPaymentConfig {
  network: string;
  payTo: `0x${string}`;
  resource: string;
  maxAmount: string;
  minPrice: string;
  nonce?: string;
}

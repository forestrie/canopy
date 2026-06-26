export function onboardGateCacheR2Key(
  chainId: string,
  univocityAddr: string,
): string {
  return `onboarding/gate-cache/${chainId.trim()}-${univocityAddr.trim()}.txt`;
}

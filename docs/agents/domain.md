# Domain terminology (Canopy)

Shared Forestrie terms: [devdocs/glossary.md](../../../devdocs/glossary.md).

## Canopy-specific

**SCRAPI worker**: Cloudflare Workers implementing grant registration, statement
ingress, forest administration, and receipt resolution.

**Transparent statement**: COSE Sign1 wrapping a Forestrie-Grant payload; used in
`Authorization: Forestrie-Grant` headers.

**MMRS-cold bootstrap**: First register-grant on a fresh log id before grant
storage is warm; uses bootstrap delegate signing path.

**Queue-only mode**: Worker configured without full bootstrap env; unsafe for
production grant auth without envelope verification.

## Related

- [CONTEXT.md stub](../../CONTEXT.md) → devdocs glossary
- [grants.md](../grants.md) — grant workflow overview

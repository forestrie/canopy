/** Internal DO JSON body for PUT /public-root/{logIdHex32}. */
export interface PutPublicRootBody {
  logIdHex32: string;
  alg: string;
  x: string;
  y: string;
}

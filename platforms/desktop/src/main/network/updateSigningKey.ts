// Public half of the Ed25519 key that signs latest-linux.yml in the release
// pipeline (GitHub secret UPDATE_SIGNING_KEY). Rotating it means shipping a build
// with the new key before releases signed by the new private key are published.
export const UPDATE_SIGNING_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAtFj52FIffQO6+p9PBENoZ9DaorX20Rz+6+GRwXDYfYo=
-----END PUBLIC KEY-----
`

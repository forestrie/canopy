canopy is both the front end and api surface for a scitt/scrapi personality transparency log

See:
- https://www.ietf.org/archive/id/draft-ietf-scitt-scrapi-05.txt
- https://www.ietf.org/archive/id/draft-ietf-scitt-architecture-22.txt


In the overall architecture:

1. We will use cloudflare workers to store pre-sequenced pre-mage data in R2.
2. We will configure event triggers to submit pre-image object references to a
   Cloudflare queue.
3. A project external sequencer will consume those events and maintain the log
4. sveltekit will be used to provide the api surface using cloudflare workers on the server routes.
5. The post object/statement routes  will respond with an optional async repsonse which simply
   provides the pre-sequence, permanent, content derived identity (described below) of the acepted
   object
6. The syncronous response will poll for, or be notified via cloudflare events,
   when the stored object has been sequenced.
7. the api will be layered: a native layer will be agnostic to scrapi
8. all request & response data will be in CBOR or COSE at both levels of the
   api

## automation

- taskfiles/cloudflare.yml will contain bootstrap, destroy and status tasks for
  managing the infra via terraform and, if appropriate, cloudflare wrangler. it
  should have a very minimal "tools-check" task that does very simple checks
for necessary opts tools and informs  where to go for install instructions for
each if any are missing
- deployment will be via vercel triggered by pushing to branches or merging to
  main. the paths in the repository need to isolate terraform and infra changes
  from impacting vercel deploy

The taskfil tasks should all source .env and .env.secrets. the .env will be
committed and must not have sensitive information. .env.secrets will be git
ignored, please provide a .env.example.secrets with placeholders for necessary secrets

## Repository layout

This repository:

- must have self contained terraform infrastructure for managing the cloudflare
  R2 and Queue resources
- must have a sveltekit fronend and cloudflare worker backend, also using
  svelte routes


The approximate layout should be:

.github/workflows/cloudflare-bootstrap.yml

cloudflare terraform and infra bootstrap
All workflows should require a cloudflare api keyMay require C

/taskfiles/ ops task files
Taskfile.dist.yml main task file includes ops task files

packages/apps/canopy - sveltekit frontend & cloudlfare workers hosting app.
will be deployed using vercel
packages/shared/ - common pacakges

I have a strong preference for using deno if it is compatible with the required
cloudflare dependencies and vercel deployment


## web app & api testing

- playwrite will be used for api testing
- deno testing will be used IF deno is compatible with all other choices
- if deno is not suitable, please make the web app and api sveltekit + vite
  based.
- if not using deno, use pnpm and pnpm workspaces

Please provide a taskfile/build.yml which does a complete build of the webapp

Ideally the vercel integration build step can use native tooling, but as far as
possible make the build.yml do the same as vercel deploy would do.

Please provide a taskfile/test.yml with a definition that would run all unit
and playwrite tests. and which would be suitable for triggering

## documentation

Succinct task oriented documentation for the following:

- first time boostraping of the project, especially note any required manual
steps such as cloudflare account creation
- how to destroy all infra
- build & test steps for the sveltekit project 

For actions that are implemented as taskfile tasks, please direct the user to
use --summary rather than repeating the content in the readme.

please also use desc so that the first line is concice, but follow up lines are
suitable as both documentation and help messages for the tasks


## Pre-sequence, permanent, content derived, object paths

The object schema will be

/logs/<LOG_ID>/leaves/{FENCE_MMRINDEX}/{MD5_CONTENT_DIGEST}

FENCE_MMRINDEX is read and derived by reading from an external service. it is a
lower bound based on the first mmrIndex in a foresrie/datatrails massif

likely it will be drived by fetching the current checkpoint for the current
(head) massif tile

An mmr index is as used in this profile
https://www.ietf.org/archive/id/draft-bryce-cose-receipts-mmr-profile-00.txt

The scitt / scrapi implementation will be using that draft

The MD5_CONTENT_DIGEST is the md5 of the pre-image and will also be used as the
etag content hash when posting the object to R2

The details of the backend routes implementation will be provided later.
For this step, providing a co-herent integration with cloudflare R2 is the
goal.

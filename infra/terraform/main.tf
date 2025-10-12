# R2 Bucket for storing SCITT/SCRAPI statements
resource "cloudflare_r2_bucket" "canopy_statements" {
  provider   = cloudflare.r2_admin
  account_id = var.cloudflare_account_id
  name       = local.r2_bucket_name
  location   = "WEUR"
}

# R2 Bucket for Terraform state (bootstrap only)
resource "cloudflare_r2_bucket" "terraform_state" {
  provider   = cloudflare.r2_admin
  account_id = var.cloudflare_account_id
  name       = local.tfstate_bucket
  location   = "WEUR"
}

# Cloudflare Queue for sequencer events
resource "cloudflare_queue" "sequencer_queue" {
  provider   = cloudflare.queue_admin
  account_id = var.cloudflare_account_id
  name       = local.queue_name
}

# Dead letter queue for failed sequencer messages
resource "cloudflare_queue" "sequencer_dlq" {
  provider   = cloudflare.queue_admin
  account_id = var.cloudflare_account_id
  name       = "${local.queue_name}-dlq"
}

# Note: Queue consumers and CORS configuration must be set up via:
# 1. Wrangler CLI for queue consumers (wrangler queues consumer add)
# 2. R2 CORS is configured via bucket settings in Cloudflare dashboard or API
# These are not yet supported in Terraform provider v4.x
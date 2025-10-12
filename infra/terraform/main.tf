# R2 Bucket for storing SCITT/SCRAPI statements
resource "cloudflare_r2_bucket" "canopy_statements" {
  account_id = var.cloudflare_account_id
  name       = local.r2_bucket_name
  location   = "auto"
}

# R2 Bucket for Terraform state (bootstrap only)
resource "cloudflare_r2_bucket" "terraform_state" {
  account_id = var.cloudflare_account_id
  name       = local.tfstate_bucket
  location   = "auto"
}

# Cloudflare Queue for sequencer events
resource "cloudflare_queue" "sequencer_queue" {
  account_id = var.cloudflare_account_id
  name       = local.queue_name
}

# Queue consumer (placeholder - will be configured by external sequencer)
resource "cloudflare_queue_consumer" "sequencer_consumer" {
  account_id = var.cloudflare_account_id
  queue_id   = cloudflare_queue.sequencer_queue.id

  settings {
    batch_size              = 10
    max_retries            = var.queue_max_retries
    visibility_timeout_ms  = var.queue_visibility_timeout_ms
  }

  # Dead letter queue for failed messages
  dead_letter_queue {
    queue_id = cloudflare_queue.sequencer_dlq.id
  }
}

# Dead letter queue for failed sequencer messages
resource "cloudflare_queue" "sequencer_dlq" {
  account_id = var.cloudflare_account_id
  name       = "${local.queue_name}-dlq"
}

# R2 CORS configuration
resource "cloudflare_r2_bucket_cors_configuration" "canopy_cors" {
  account_id = var.cloudflare_account_id
  bucket     = cloudflare_r2_bucket.canopy_statements.name

  cors_rule {
    allowed_origins = var.r2_cors_allowed_origins
    allowed_methods = ["GET", "HEAD", "POST", "PUT"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag", "Content-Type", "Content-Length"]
    max_age_seconds = 3600
  }
}
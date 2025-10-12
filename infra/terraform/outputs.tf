output "r2_bucket_name" {
  description = "Name of the R2 bucket for statements"
  value       = cloudflare_r2_bucket.canopy_statements.name
}

output "r2_bucket_id" {
  description = "ID of the R2 bucket"
  value       = cloudflare_r2_bucket.canopy_statements.id
}

output "queue_name" {
  description = "Name of the sequencer queue"
  value       = cloudflare_queue.sequencer_queue.name
}

output "queue_id" {
  description = "ID of the sequencer queue"
  value       = cloudflare_queue.sequencer_queue.id
}

output "dlq_name" {
  description = "Name of the dead letter queue"
  value       = cloudflare_queue.sequencer_dlq.name
}

output "tfstate_bucket_name" {
  description = "Name of the Terraform state bucket"
  value       = cloudflare_r2_bucket.terraform_state.name
}

output "r2_endpoint" {
  description = "R2 endpoint URL for S3 compatibility"
  value       = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
}

output "forest_project_id" {
  description = "Forest project identifier used for resource naming"
  value       = var.forest_project_id
}
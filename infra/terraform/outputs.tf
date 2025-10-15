output "r2_bucket_name" {
  description = "Name of the R2 bucket for statements"
  value       = cloudflare_r2_bucket.canopy_statements.name
}

output "r2_bucket_id" {
  description = "ID of the R2 bucket"
  value       = cloudflare_r2_bucket.canopy_statements.id
}

## Queue outputs removed per current design

output "tfstate_bucket_name" {
  description = "Name of the Terraform state bucket"
  value       = cloudflare_r2_bucket.terraform_state.name
}

output "r2_endpoint" {
  description = "R2 endpoint URL for S3 compatibility"
  value       = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
}

output "canopy_id" {
  description = "Canopy instance identifier"
  value       = var.canopy_id
}

output "canopy_state_id" {
  description = "Canopy state identifier for Terraform state"
  value       = var.canopy_state_id
}

output "forest_project_id" {
  description = "Forest project identifier (external reference)"
  value       = var.forest_project_id
}
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

# Note: Queue resources intentionally omitted per current design
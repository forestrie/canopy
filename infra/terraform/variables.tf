variable "r2_admin_token" {
  description = "Cloudflare API token with R2 admin permissions for creating/destroying buckets"
  type        = string
  sensitive   = true
}


variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
  default     = "68f25af297c4235c3f1c47b2f73925b0"
}

variable "canopy_id" {
  description = "Canopy instance identifier for resource naming"
  type        = string
  default     = "canopy-dev-1"
}

variable "canopy_state_id" {
  description = "Canopy state identifier for Terraform state bucket"
  type        = string
  default     = "canopy-dev-1"
}

variable "forest_project_id" {
  description = "Forest project identifier (external reference for integration)"
  type        = string
  default     = "forest-dev-1"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "r2_cors_allowed_origins" {
  description = "CORS allowed origins for R2 bucket"
  type        = list(string)
  default = [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://*.vercel.app"
  ]
}


# Computed locals for resource naming
locals {
  r2_bucket_name = "${var.canopy_id}-statements"
  tfstate_bucket = "${var.canopy_state_id}-tfstate"
}
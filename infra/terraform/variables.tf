variable "cloudflare_api_token" {
  description = "Cloudflare API token with permissions for R2 and Queues"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
  default     = "68f25af297c4235c3f1c47b2f73925b0"
}

variable "forest_project_id" {
  description = "Forest project identifier for resource naming"
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

variable "queue_max_retries" {
  description = "Maximum number of retries for queue messages"
  type        = number
  default     = 3
}

variable "queue_visibility_timeout_ms" {
  description = "Visibility timeout for queue messages in milliseconds"
  type        = number
  default     = 30000 # 30 seconds
}

# Computed locals for resource naming
locals {
  r2_bucket_name = "${var.forest_project_id}-canopy"
  queue_name     = "${var.forest_project_id}-ranger"
  tfstate_bucket = "${var.forest_project_id}-tfstate"
}
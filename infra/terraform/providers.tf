terraform {
  required_version = ">= 1.5.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.1"
    }
  }

  # Backend configuration for storing state in R2
  # Uncomment and configure after initial bootstrap
  # Replace ${CANOPY_STATE_ID} with your actual canopy state id
  # backend "s3" {
  #   bucket                      = "${CANOPY_STATE_ID}-tfstate"
  #   key                        = "terraform.tfstate"
  #   region                     = "auto"
  #   skip_credentials_validation = true
  #   skip_metadata_api_check     = true
  #   skip_region_validation      = true
  #   force_path_style            = true
  #   endpoints = {
  #     s3 = "https://<account-id>.r2.cloudflarestorage.com"
  #   }
  # }
}

provider "cloudflare" {
  alias     = "r2_admin"
  api_token = var.r2_admin_token
}

provider "cloudflare" {
  alias     = "queue_admin"
  api_token = var.queue_admin_token
}

# Default provider uses R2 admin for backward compatibility
provider "cloudflare" {
  api_token = var.r2_admin_token
}
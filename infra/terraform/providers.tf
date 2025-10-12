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
  # Replace ${FOREST_PROJECT_ID} with your actual forest project id
  # backend "s3" {
  #   bucket                      = "${FOREST_PROJECT_ID}-tfstate"
  #   key                        = "canopy/terraform.tfstate"
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
  api_token = var.cloudflare_api_token
}
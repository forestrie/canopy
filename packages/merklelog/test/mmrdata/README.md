# MMR Test Data

This directory contains static example log data for testing the massifs module.

## Format

The test data files are binary massif blob files following the format:

- 32-byte header (MassifStart)
- Reserved header slots (7 \* 32 bytes)
- Trie data
- Peak stack
- MMR data

## Usage

Test files should read these binary files and use them to test the Massif class
and related functionality.

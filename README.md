# InfraZero (Global AI Studio)

Deploy AI models globally in 60 seconds with automatic failover.

## Architecture
- **model-service**: Simulates AI inference (3 instances = 3 regions)
- **control-plane**: Orchestrates routing and failover
- **dashboard**: Next.js UI with world map

## Challenge
Best Use of Vultr - MLH Hackathon

## Demo
1. Deploy globally (3 regions)
2. Generate images (auto-routes to fastest)
3. Kill region live (watch failover)
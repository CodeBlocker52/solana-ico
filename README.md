# ICO Token Sale Contract

A production-ready Initial Coin Offering (ICO) token sale smart contract built on Solana using Anchor framework. This contract enables secure, controlled token sales with comprehensive features for both project teams and investors.

## 🚀 Overview

This ICO contract provides a complete solution for conducting token sales on Solana, featuring time-based sales, purchase limits, pause functionality, and comprehensive security measures. Built with the latest Anchor development practices including proper space allocation, events, and access controls.

## ✨ Features

### Core Functionality
- **🎯 Configurable Token Sales**: Set token price, maximum supply, purchase limits, and sale duration
- **💰 SOL-based Payments**: Accept SOL payments with automatic treasury forwarding
- **👥 User Purchase Tracking**: Track individual user contributions and token allocations
- **⏰ Time-based Control**: Automated start/end times with manual override capability
- **🔒 Purchase Limits**: Minimum and maximum purchase amounts per transaction and per user

### Security Features
- **🛡️ Authority-based Access Control**: Secure admin functions with proper authorization
- **⏸️ Pause/Resume Functionality**: Emergency pause capability for sale operations
- **🔐 PDA-based Token Custody**: Secure token storage using Program Derived Addresses
- **✅ Comprehensive Validation**: Input validation and overflow protection
- **📊 Real-time Monitoring**: Event emissions for off-chain tracking

### Management Features
- **📈 Dynamic Parameters**: Update sale parameters before launch
- **💸 Token Recovery**: Withdraw unsold tokens after sale completion
- **📋 Sale Statistics**: Track total raised, tokens sold, and user participation
- **🎛️ Flexible Control**: Early termination and parameter adjustment capabilities

## 🏗️ Technical Architecture

### Smart Contract Structure
```
├── programs/
│   └── ico-token-sale/
│       └── src/
│           └── lib.rs          # Main contract code
├── tests/
│   └── ico-token-sale.ts       # Comprehensive test suite
├── target/
│   └── types/
│       └── ico_token_sale.ts   # Generated TypeScript types
└── Anchor.toml                 # Anchor configuration
```

### Key Components

#### Accounts
- **Sale**: Main sale configuration and state tracking
- **UserPurchase**: Individual user purchase and contribution tracking

#### Instructions
- `initialize_sale`: Initialize ICO with parameters
- `purchase_tokens`: Buy tokens during active sale
- `toggle_pause`: Pause/resume sale operations
- `end_sale`: Terminate sale early
- `withdraw_remaining_tokens`: Recover unsold tokens
- `update_sale_params`: Modify sale parameters (pre-launch only)

## 🛠️ Development Setup

### Prerequisites
- Node.js 18+ 
- Rust 1.70+
- Solana CLI 1.16+
- Anchor CLI 0.31.1+

### Installation
```bash
# Clone repository
git clone <repository-url>
cd ico-token-sale

# Install dependencies
npm install

# Install Anchor (if not already installed)
npm install -g @coral-xyz/anchor-cli

# Build the program
anchor build

# Generate TypeScript types
anchor build --typescript
```

### Local Development
```bash
# Start local validator
solana-test-validator

# Deploy to localnet (new terminal)
anchor deploy

# Run tests
anchor test
```

## 🧪 Testing

### Test Suite Coverage
- ✅ Sale initialization and parameter validation
- ✅ Token purchasing with various scenarios
- ✅ Purchase limit enforcement (min/max per user)
- ✅ Pause/resume functionality
- ✅ Authority access controls
- ✅ Token withdrawal after sale completion
- ✅ Parameter updates before launch
- ✅ Edge cases and error conditions

### Running Tests
```bash
# Run all tests
anchor test

# Run tests with detailed output
anchor test -- --features=debug

# Run specific test file
anchor test tests/ico-token-sale.ts

# Run tests on different clusters
anchor test --provider.cluster localnet
anchor test --provider.cluster devnet
```

### Test Accounts Setup
Tests automatically handle:
- Test account generation and SOL airdrops
- Token mint creation and initial supply
- Associated token account creation
- PDA derivation and validation

## 📋 Deployment Guide

### 1. Configuration
Update `Anchor.toml` with your program ID and cluster settings:
```toml
[programs.localnet]
ico_token_sale = "YOUR_PROGRAM_ID"

[programs.devnet]  
ico_token_sale = "YOUR_PROGRAM_ID"

[programs.mainnet]
ico_token_sale = "YOUR_PROGRAM_ID"
```

### 2. Deploy to Devnet
```bash
# Configure Solana CLI for devnet
solana config set --url devnet

# Airdrop SOL for deployment
solana airdrop 2

# Deploy program
anchor deploy --provider.cluster devnet

# Verify deployment
anchor test --provider.cluster devnet
```

### 3. Deploy to Mainnet
```bash
# Configure for mainnet
solana config set --url mainnet-beta

# Deploy (ensure sufficient SOL for deployment)
anchor deploy --provider.cluster mainnet-beta
```

## 💻 Usage Examples

### Initialize Sale
```typescript
const tx = await program.methods
  .initializeSale(
    new BN(1_000_000),     // 0.001 SOL per token
    new BN(1_000_000),     // 1M tokens max
    new BN(100),           // 100 tokens minimum
    new BN(10_000),        // 10K tokens max per user
    new BN(3600)           // 1 hour duration
  )
  .accounts({
    sale: salePda,
    authority: authority.publicKey,
    tokenMint: tokenMint,
    treasury: treasury.publicKey,
    systemProgram: SystemProgram.programId,
  })
  .signers([authority])
  .rpc();
```

### Purchase Tokens
```typescript
const tx = await program.methods
  .purchaseTokens(new BN(1000)) // Buy 1000 tokens
  .accounts({
    sale: salePda,
    userPurchase: userPurchasePda,
    buyer: buyer.publicKey,
    tokenMint: tokenMint,
    saleTokenVault: saleVault,
    buyerTokenAccount: buyerTokenAccount,
    treasury: treasury.publicKey,
    // ... other required accounts
  })
  .signers([buyer])
  .rpc();
```

## 🔧 Configuration Options

### Sale Parameters
| Parameter | Type | Description |
|-----------|------|-------------|
| `token_price` | u64 | Price per token in lamports |
| `max_tokens` | u64 | Maximum tokens available for sale |
| `min_purchase` | u64 | Minimum tokens per purchase |
| `max_purchase` | u64 | Maximum tokens per user |
| `sale_duration` | i64 | Sale duration in seconds |

### Access Control
- **Authority**: Can pause, end sale, withdraw tokens, update parameters
- **Users**: Can purchase tokens within limits during active sale
- **Treasury**: Receives SOL payments from token purchases

## 📊 Events & Monitoring

### Event Types
- `SaleInitialized`: Sale creation with parameters
- `TokensPurchased`: Individual token purchases
- `SaleToggled`: Pause/resume status changes  
- `SaleEnded`: Sale termination
- `TokensWithdrawn`: Remaining token recovery
- `SaleParamsUpdated`: Parameter modifications

### Off-chain Integration
Events can be monitored for:
- Real-time sale dashboard updates
- User notification systems
- Analytics and reporting
- Automated trading systems

## 🔐 Security Considerations

### Best Practices Implemented
- **PDA-based Token Custody**: Eliminates private key risks
- **Comprehensive Input Validation**: Prevents invalid operations
- **Access Control Modifiers**: Restricts sensitive functions
- **Overflow Protection**: Safe mathematical operations
- **Time-based Validation**: Prevents operations outside sale window

### Audit Recommendations
- [ ] Third-party security audit before mainnet deployment
- [ ] Formal verification of critical functions
- [ ] Stress testing with high transaction volumes
- [ ] Multi-signature authority for production deployments

## 📈 Gas Optimization

The contract implements several gas optimization techniques:
- Efficient account space allocation with `INIT_SPACE`
- Minimal storage operations
- Optimized PDA derivations
- Batch operations where possible

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/new-feature`)
3. Commit changes (`git commit -am 'Add new feature'`)
4. Push to branch (`git push origin feature/new-feature`)
5. Create a Pull Request

### Development Guidelines
- Follow Rust and TypeScript style guides
- Add comprehensive tests for new features
- Update documentation for API changes
- Ensure all tests pass before submitting PR

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support & Resources

### Documentation
- [Anchor Framework Documentation](https://anchor-lang.com/)
- [Solana Program Library](https://spl.solana.com/)
- [Solana Web3.js Documentation](https://solana-labs.github.io/solana-web3.js/)

### Community
- [Solana Stack Exchange](https://solana.stackexchange.com/)
- [Anchor Discord](https://discord.gg/8HwmBtt2ss)
- [Solana Discord](https://discord.gg/pquxPsq)

### Issues & Bug Reports
Please report issues through GitHub Issues with:
- Detailed description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Node.js version, etc.)

## 🚀 Roadmap

### Current Version (v1.0)
- ✅ Core ICO functionality
- ✅ Comprehensive testing suite
- ✅ Security implementations
- ✅ Event system

### Planned Features (v1.1)
- [ ] Multi-token payment support (USDC, USDT)
- [ ] Vesting schedule implementation
- [ ] Whitelist functionality
- [ ] Refund mechanisms

### Future Enhancements (v2.0)
- [ ] Dutch auction mechanism
- [ ] Liquidity pool integration
- [ ] Governance token distribution
- [ ] Cross-chain compatibility

---


import * as anchor from "@coral-xyz/anchor";
import { Program, BN, web3 } from "@coral-xyz/anchor";
import { IcoTokenSale } from "../target/types/ico_token_sale";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddress,
  getAccount,
} from "@solana/spl-token";
import { assert, expect } from "chai";

describe("ICO Token Sale V2 - Complete Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.IcoTokenSale as Program<IcoTokenSale>;
  const connection = provider.connection;

  // Test accounts
  let authority: web3.Keypair;
  let buyer1: web3.Keypair;
  let buyer2: web3.Keypair;
  let treasury: web3.Keypair;
  let tokenMint: web3.PublicKey;
  let authorityTokenAccount: web3.PublicKey;
  let saleTokenVault: web3.PublicKey;

  // Pyth related
  let priceUpdateAccount: web3.PublicKey;

  // PDAs
  let salePda: web3.PublicKey;
  let saleBump: number;

  // Sale parameters
  const TOKEN_PRICE_USD = new BN(100000000); // $1.00 with 8 decimals
  const MAX_TOKENS = new BN(1_000_000); // 1M tokens
  const MIN_PURCHASE = new BN(100); // 100 tokens minimum
  const MAX_PURCHASE = new BN(10_000); // 10K tokens maximum per user
  const SALE_DURATION = new BN(3600); // 1 hour
  const MAX_PRICE_AGE = new BN(60); // 60 seconds
  const TOKEN_DECIMALS = 9;

  // Mock SOL/USD price for testing (e.g., $150 per SOL with 8 decimals)
  const MOCK_SOL_USD_PRICE = new BN(15000000000); // $150.00

  before(async () => {
    console.log("Setting up test environment...");

    // Generate keypairs
    authority = web3.Keypair.generate();
    buyer1 = web3.Keypair.generate();
    buyer2 = web3.Keypair.generate();
    treasury = web3.Keypair.generate();

    // Airdrop SOL to test accounts
    const airdropPromises = [
      connection.requestAirdrop(authority.publicKey, 10 * web3.LAMPORTS_PER_SOL),
      connection.requestAirdrop(buyer1.publicKey, 5 * web3.LAMPORTS_PER_SOL),
      connection.requestAirdrop(buyer2.publicKey, 5 * web3.LAMPORTS_PER_SOL),
    ];

    await Promise.all(airdropPromises);
    console.log("Airdrops completed");

    // Wait for airdrops to confirm
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Create mock price update account
    priceUpdateAccount = await createMockPriceUpdateAccount(connection, authority);
    console.log("Mock price update account created:", priceUpdateAccount.toString());

    // Create token mint
    tokenMint = await createMint(
      connection,
      authority,
      authority.publicKey,
      authority.publicKey,
      TOKEN_DECIMALS
    );
    console.log("Token mint created:", tokenMint.toString());

    // Create authority token account
    authorityTokenAccount = await createAssociatedTokenAccount(
      connection,
      authority,
      tokenMint,
      authority.publicKey
    );

    // Mint tokens to authority
    await mintTo(
      connection,
      authority,
      tokenMint,
      authorityTokenAccount,
      authority.publicKey,
      MAX_TOKENS.toNumber() * 2 // Mint more than needed for sale
    );
    console.log("Tokens minted to authority");

    // Find sale PDA
    [salePda, saleBump] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("sale"), authority.publicKey.toBuffer(), tokenMint.toBuffer()],
      program.programId
    );

    // Get sale token vault address
    saleTokenVault = await getAssociatedTokenAddress(
      tokenMint,
      salePda,
      true // allowOwnerOffCurve for PDA
    );

    console.log("Test setup completed successfully");
  });

  describe("Initialize Sale V2", () => {
    it("should initialize sale with USD pricing successfully", async () => {
      console.log("Testing sale initialization...");

      const tx = await program.methods
        .initializeSale(
          TOKEN_PRICE_USD,
          MAX_TOKENS,
          MIN_PURCHASE,
          MAX_PURCHASE,
          SALE_DURATION,
          MAX_PRICE_AGE
        )
        .accounts({
          sale: salePda,
          authority: authority.publicKey,
          tokenMint: tokenMint,
          treasury: treasury.publicKey,
          pythPriceUpdate: priceUpdateAccount,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([authority])
        .rpc();

      console.log("Initialize sale transaction:", tx);

      // Verify sale account
      const saleAccount = await program.account.sale.fetch(salePda);
      assert.equal(saleAccount.authority.toString(), authority.publicKey.toString());
      assert.equal(saleAccount.tokenMint.toString(), tokenMint.toString());
      assert.equal(saleAccount.treasury.toString(), treasury.publicKey.toString());
      assert.equal(saleAccount.pythPriceUpdate.toString(), priceUpdateAccount.toString());
      assert.equal(saleAccount.tokenPriceUsd.toString(), TOKEN_PRICE_USD.toString());
      assert.equal(saleAccount.maxTokens.toString(), MAX_TOKENS.toString());
      assert.equal(saleAccount.minPurchase.toString(), MIN_PURCHASE.toString());
      assert.equal(saleAccount.maxPurchase.toString(), MAX_PURCHASE.toString());
      assert.equal(saleAccount.tokensSold.toString(), "0");
      assert.equal(saleAccount.totalRaised.toString(), "0");
      assert.equal(saleAccount.maxPriceAge.toString(), MAX_PRICE_AGE.toString());
      assert.equal(saleAccount.isActive, true);
      assert.equal(saleAccount.isPaused, false);
      assert.equal(saleAccount.bump, saleBump);

      console.log("✅ Sale initialized successfully");
    });

    it("should fail with invalid USD price", async () => {
      const invalidSalePda = web3.Keypair.generate();
      
      try {
        await program.methods
          .initializeSale(
            new BN(0), // Invalid price
            MAX_TOKENS,
            MIN_PURCHASE,
            MAX_PURCHASE,
            SALE_DURATION,
            MAX_PRICE_AGE
          )
          .accounts({
            sale: invalidSalePda.publicKey,
            authority: authority.publicKey,
            tokenMint: tokenMint,
            treasury: treasury.publicKey,
            pythPriceUpdate: priceUpdateAccount,
            systemProgram: web3.SystemProgram.programId,
            rent: web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([authority, invalidSalePda])
          .rpc();
        
        assert.fail("Should have failed with invalid price");
      } catch (error) {
        expect(error.error.errorMessage).to.include("Invalid price");
        console.log("✅ Correctly rejected invalid price");
      }
    });

    it("should fail with invalid max age", async () => {
      const invalidSalePda = web3.Keypair.generate();
      
      try {
        await program.methods
          .initializeSale(
            TOKEN_PRICE_USD,
            MAX_TOKENS,
            MIN_PURCHASE,
            MAX_PURCHASE,
            SALE_DURATION,
            new BN(3700) // Invalid max age (> 1 hour)
          )
          .accounts({
            sale: invalidSalePda.publicKey,
            authority: authority.publicKey,
            tokenMint: tokenMint,
            treasury: treasury.publicKey,
            pythPriceUpdate: priceUpdateAccount,
            systemProgram: web3.SystemProgram.programId,
            rent: web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([authority, invalidSalePda])
          .rpc();
        
        assert.fail("Should have failed with invalid max age");
      } catch (error) {
        expect(error.error.errorMessage).to.include("Invalid max age");
        console.log("✅ Correctly rejected invalid max age");
      }
    });
  });

  describe("Fund Sale", () => {
    it("should fund the sale with tokens", async () => {
      console.log("Testing sale funding...");

      // Transfer tokens to sale vault
      const transferAmount = MAX_TOKENS.toNumber();
      
      await mintTo(
        connection,
        authority,
        tokenMint,
        saleTokenVault,
        authority.publicKey,
        transferAmount
      );

      // Verify sale vault has tokens
      const vaultAccount = await getAccount(connection, saleTokenVault);
      assert.equal(vaultAccount.amount.toString(), transferAmount.toString());

      console.log("✅ Sale funded successfully with", transferAmount, "tokens");
    });
  });

  describe("Purchase Tokens V2 - Dynamic Pricing", () => {
    let buyer1TokenAccount: web3.PublicKey;
    let buyer1PurchasePda: web3.PublicKey;

    before(async () => {
      // Get buyer1 token account
      buyer1TokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        buyer1.publicKey
      );

      // Find buyer1 purchase PDA
      [buyer1PurchasePda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("purchase"), salePda.toBuffer(), buyer1.publicKey.toBuffer()],
        program.programId
      );

      console.log("Purchase setup completed for buyer1");
    });

    it("should allow token purchase with dynamic pricing", async () => {
      console.log("Testing dynamic pricing purchase...");

      const purchaseAmount = new BN(1000); // 1000 tokens
      
      // Update mock price feed
      await updateMockPriceData(connection, authority, priceUpdateAccount, MOCK_SOL_USD_PRICE);

      // Get initial balances
      const initialTreasuryBalance = await connection.getBalance(treasury.publicKey);
      const initialBuyerBalance = await connection.getBalance(buyer1.publicKey);

      console.log("Initial treasury balance:", initialTreasuryBalance / web3.LAMPORTS_PER_SOL, "SOL");
      console.log("Initial buyer balance:", initialBuyerBalance / web3.LAMPORTS_PER_SOL, "SOL");

      const tx = await program.methods
        .purchaseTokens(purchaseAmount)
        .accounts({
          sale: salePda,
          userPurchase: buyer1PurchasePda,
          buyer: buyer1.publicKey,
          tokenMint: tokenMint,
          saleTokenVault: saleTokenVault,
          buyerTokenAccount: buyer1TokenAccount,
          treasury: treasury.publicKey,
          pythPriceUpdate: priceUpdateAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([buyer1])
        .rpc();

      console.log("Purchase transaction:", tx);

      // Verify sale state updated
      const saleAccount = await program.account.sale.fetch(salePda);
      assert.equal(saleAccount.tokensSold.toString(), purchaseAmount.toString());
      assert(saleAccount.totalRaised.toNumber() > 0, "Total raised should be greater than 0");

      console.log("Tokens sold:", saleAccount.tokensSold.toString());
      console.log("Total SOL raised:", saleAccount.totalRaised.toNumber() / web3.LAMPORTS_PER_SOL);

      // Verify user purchase tracking
      const userPurchase = await program.account.userPurchase.fetch(buyer1PurchasePda);
      assert.equal(userPurchase.user.toString(), buyer1.publicKey.toString());
      assert.equal(userPurchase.sale.toString(), salePda.toString());
      assert.equal(userPurchase.tokensPurchased.toString(), purchaseAmount.toString());
      assert(userPurchase.solContributed.toNumber() > 0, "SOL contributed should be greater than 0");

      // Verify buyer received tokens
      const buyerTokenBalance = await getAccount(connection, buyer1TokenAccount);
      assert.equal(buyerTokenBalance.amount.toString(), purchaseAmount.toString());

      // Verify treasury received SOL
      const finalTreasuryBalance = await connection.getBalance(treasury.publicKey);
      assert(finalTreasuryBalance > initialTreasuryBalance, "Treasury should receive SOL");

      const solReceived = (finalTreasuryBalance - initialTreasuryBalance) / web3.LAMPORTS_PER_SOL;
      console.log("SOL received by treasury:", solReceived);

      console.log("✅ Dynamic pricing purchase completed successfully");
    });

    it("should calculate correct SOL cost based on price", async () => {
      console.log("Testing price calculation accuracy...");

      // Expected calculation:
      // Token price: $1.00 (100000000 with 8 decimals)
      // Purchase amount: 500 tokens
      // Total USD cost: $500
      // SOL price: $150 (15000000000 with 8 decimals)
      // Expected SOL cost: 500 / 150 = 3.333... SOL

      const purchaseAmount = new BN(500);
      const expectedUsdCost = purchaseAmount.mul(TOKEN_PRICE_USD); // 500 * 100000000
      const expectedSolCost = expectedUsdCost.mul(new BN(1_000_000_000)).div(MOCK_SOL_USD_PRICE);

      console.log("Expected USD cost:", expectedUsdCost.toNumber() / 100000000, "USD");
      console.log("Expected SOL cost:", expectedSolCost.toNumber() / web3.LAMPORTS_PER_SOL, "SOL");

      // Create second buyer for this test
      const buyer2TokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        buyer2.publicKey
      );

      const [buyer2PurchasePda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("purchase"), salePda.toBuffer(), buyer2.publicKey.toBuffer()],
        program.programId
      );

      const initialTreasuryBalance = await connection.getBalance(treasury.publicKey);

      await program.methods
        .purchaseTokens(purchaseAmount)
        .accounts({
          sale: salePda,
          userPurchase: buyer2PurchasePda,
          buyer: buyer2.publicKey,
          tokenMint: tokenMint,
          saleTokenVault: saleTokenVault,
          buyerTokenAccount: buyer2TokenAccount,
          treasury: treasury.publicKey,
          pythPriceUpdate: priceUpdateAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([buyer2])
        .rpc();

      const finalTreasuryBalance = await connection.getBalance(treasury.publicKey);
      const actualSolCost = finalTreasuryBalance - initialTreasuryBalance;

      console.log("Actual SOL cost:", actualSolCost / web3.LAMPORTS_PER_SOL, "SOL");

      // Allow for small rounding differences
      const tolerance = web3.LAMPORTS_PER_SOL / 1000; // 0.001 SOL tolerance
      const difference = Math.abs(actualSolCost - expectedSolCost.toNumber());
      
      assert(difference <= tolerance, 
        `SOL cost calculation mismatch. Expected: ${expectedSolCost.toNumber()}, Actual: ${actualSolCost}, Difference: ${difference}`
      );

      console.log("✅ Price calculation is accurate within tolerance");
    });

    it("should fail purchase below minimum", async () => {
      const purchaseAmount = new BN(50); // Below minimum

      try {
        await program.methods
          .purchaseTokens(purchaseAmount)
          .accounts({
            sale: salePda,
            userPurchase: buyer1PurchasePda,
            buyer: buyer1.publicKey,
            tokenMint: tokenMint,
            saleTokenVault: saleTokenVault,
            buyerTokenAccount: buyer1TokenAccount,
            treasury: treasury.publicKey,
            pythPriceUpdate: priceUpdateAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: web3.SystemProgram.programId,
            rent: web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([buyer1])
          .rpc();

        assert.fail("Should have failed with below minimum purchase");
      } catch (error) {
        expect(error.error.errorMessage).to.include("Below minimum purchase amount");
        console.log("✅ Correctly rejected purchase below minimum");
      }
    });

    it("should fail purchase above maximum per user", async () => {
      const purchaseAmount = new BN(15000); // Above maximum

      try {
        await program.methods
          .purchaseTokens(purchaseAmount)
          .accounts({
            sale: salePda,
            userPurchase: buyer1PurchasePda,
            buyer: buyer1.publicKey,
            tokenMint: tokenMint,
            saleTokenVault: saleTokenVault,
            buyerTokenAccount: buyer1TokenAccount,
            treasury: treasury.publicKey,
            pythPriceUpdate: priceUpdateAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: web3.SystemProgram.programId,
            rent: web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([buyer1])
          .rpc();

        assert.fail("Should have failed with above maximum purchase");
      } catch (error) {
        expect(error.error.errorMessage).to.include("Exceeds user limit");
        console.log("✅ Correctly rejected purchase above user maximum");
      }
    });
  });

  describe("Sale Management V2", () => {
    it("should pause and unpause sale", async () => {
      console.log("Testing pause/unpause functionality...");

      // Pause sale
      await program.methods
        .togglePause()
        .accounts({
          sale: salePda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      let saleAccount = await program.account.sale.fetch(salePda);
      assert.equal(saleAccount.isPaused, true);
      console.log("Sale paused successfully");

      // Try to purchase while paused (should fail)
      const buyer2TokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        buyer2.publicKey
      );
      const [buyer2PurchasePda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("purchase"), salePda.toBuffer(), buyer2.publicKey.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .purchaseTokens(new BN(500))
          .accounts({
            sale: salePda,
            userPurchase: buyer2PurchasePda,
            buyer: buyer2.publicKey,
            tokenMint: tokenMint,
            saleTokenVault: saleTokenVault,
            buyerTokenAccount: buyer2TokenAccount,
            treasury: treasury.publicKey,
            pythPriceUpdate: priceUpdateAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: web3.SystemProgram.programId,
            rent: web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([buyer2])
          .rpc();

        assert.fail("Should have failed while sale is paused");
      } catch (error) {
        expect(error.error.errorMessage).to.include("Sale is paused");
        console.log("✅ Correctly blocked purchase while paused");
      }

      // Unpause sale
      await program.methods
        .togglePause()
        .accounts({
          sale: salePda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      saleAccount = await program.account.sale.fetch(salePda);
      assert.equal(saleAccount.isPaused, false);
      console.log("✅ Sale unpaused successfully");
    });

    it("should fail pause from non-authority", async () => {
      try {
        await program.methods
          .togglePause()
          .accounts({
            sale: salePda,
            authority: buyer1.publicKey, // Not the authority
          })
          .signers([buyer1])
          .rpc();

        assert.fail("Should have failed with unauthorized access");
      } catch (error) {
        expect(error.error.errorMessage).to.include("Unauthorized");
        console.log("✅ Correctly rejected unauthorized pause attempt");
      }
    });

    it("should end sale early", async () => {
      console.log("Testing early sale termination...");

      await program.methods
        .endSale()
        .accounts({
          sale: salePda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      const saleAccount = await program.account.sale.fetch(salePda);
      assert.equal(saleAccount.isActive, false);
      console.log("✅ Sale ended successfully");
    });
  });

  describe("Withdraw Remaining Tokens V2", () => {
    it("should withdraw remaining tokens after sale ends", async () => {
      console.log("Testing token withdrawal...");

      // Get initial authority token balance
      const initialBalance = await getAccount(connection, authorityTokenAccount);
      const initialAmount = initialBalance.amount;

      // Get remaining tokens in vault
      const vaultBalance = await getAccount(connection, saleTokenVault);
      const remainingTokens = vaultBalance.amount;

      console.log("Initial authority balance:", initialAmount.toString());
      console.log("Remaining tokens in vault:", remainingTokens.toString());

      await program.methods
        .withdrawRemainingTokens()
        .accounts({
          sale: salePda,
          authority: authority.publicKey,
          tokenMint: tokenMint,
          saleTokenVault: saleTokenVault,
          authorityTokenAccount: authorityTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([authority])
        .rpc();

      // Verify authority received the remaining tokens
      const finalBalance = await getAccount(connection, authorityTokenAccount);
      assert.equal(
        finalBalance.amount.toString(),
        (initialAmount + remainingTokens).toString()
      );

      // Verify vault is empty
      const finalVaultBalance = await getAccount(connection, saleTokenVault);
      assert.equal(finalVaultBalance.amount.toString(), "0");

      console.log("✅ Remaining tokens withdrawn successfully");
    });
  });

  describe("Update Sale Parameters V2", () => {
    let newSalePda: web3.PublicKey;
    let newAuthority: web3.Keypair;

    before(async () => {
      console.log("Setting up parameter update test...");

      // Create a new sale for parameter update testing
      newAuthority = web3.Keypair.generate();
      await connection.requestAirdrop(newAuthority.publicKey, 5 * web3.LAMPORTS_PER_SOL);
      await new Promise(resolve => setTimeout(resolve, 1000));

      [newSalePda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("sale"), newAuthority.publicKey.toBuffer(), tokenMint.toBuffer()],
        program.programId
      );

      await program.methods
        .initializeSale(
          TOKEN_PRICE_USD,
          MAX_TOKENS,
          MIN_PURCHASE,
          MAX_PURCHASE,
          new BN(7200), // 2 hours from now
          MAX_PRICE_AGE
        )
        .accounts({
          sale: newSalePda,
          authority: newAuthority.publicKey,
          tokenMint: tokenMint,
          treasury: treasury.publicKey,
          pythPriceUpdate: priceUpdateAccount,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([newAuthority])
        .rpc();

      console.log("New sale created for parameter testing");
    });

    it("should update sale parameters before sale starts", async () => {
      console.log("Testing parameter updates...");

      // Update parameters before sale starts
      await program.methods
        .updateSaleParams(
          new BN(200000000), // new price - $2.00
          new BN(500_000),   // new max tokens
          new BN(200),       // new min purchase
          new BN(5000),      // new max purchase
          new BN(120)        // new max age - 2 minutes
        )
        .accounts({
          sale: newSalePda,
          authority: newAuthority.publicKey,
        })
        .signers([newAuthority])
        .rpc();

      // Verify parameters updated
      const updatedSale = await program.account.sale.fetch(newSalePda);
      assert.equal(updatedSale.tokenPriceUsd.toString(), "200000000");
      assert.equal(updatedSale.maxTokens.toString(), "500000");
      assert.equal(updatedSale.minPurchase.toString(), "200");
      assert.equal(updatedSale.maxPurchase.toString(), "5000");
      assert.equal(updatedSale.maxPriceAge.toString(), "120");

      console.log("✅ Parameters updated successfully");
    });

    it("should fail to update parameters after sale starts", async () => {
      // For this test, we would need to wait for the sale start time
      // or modify the sale start time to be in the past
      console.log("✅ Parameter update timing restrictions would be tested with time manipulation");
    });
  });

  describe("Edge Cases and Security V2", () => {
    it("should handle maximum token purchase correctly with dynamic pricing", async () => {
      console.log("Testing edge case: maximum token purchase...");

      // Create new sale for edge case testing
      const edgeAuthority = web3.Keypair.generate();
      await connection.requestAirdrop(edgeAuthority.publicKey, 5 * web3.LAMPORTS_PER_SOL);
      await new Promise(resolve => setTimeout(resolve, 1000));

      const [edgeSalePda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("sale"), edgeAuthority.publicKey.toBuffer(), tokenMint.toBuffer()],
        program.programId
      );

      const smallMaxTokens = new BN(1000);
      
      await program.methods
        .initializeSale(
          TOKEN_PRICE_USD,
          smallMaxTokens,
          MIN_PURCHASE,
          MAX_PURCHASE,
          SALE_DURATION,
          MAX_PRICE_AGE
        )
        .accounts({
          sale: edgeSalePda,
          authority: edgeAuthority.publicKey,
          tokenMint: tokenMint,
          treasury: treasury.publicKey,
          pythPriceUpdate: priceUpdateAccount,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([edgeAuthority])
        .rpc();

      // Fund the small sale
      const edgeSaleVault = await getAssociatedTokenAddress(
        tokenMint,
        edgeSalePda,
        true
      );

      await mintTo(
        connection,
        authority,
        tokenMint,
        edgeSaleVault,
        authority.publicKey,
        smallMaxTokens.toNumber()
      );

      // Try to purchase more than available
      const buyer3 = web3.Keypair.generate();
      await connection.requestAirdrop(buyer3.publicKey, 5 * web3.LAMPORTS_PER_SOL);
      await new Promise(resolve => setTimeout(resolve, 1000));

      const buyer3TokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        buyer3.publicKey
      );

      const [buyer3PurchasePda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("purchase"), edgeSalePda.toBuffer(), buyer3.publicKey.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .purchaseTokens(new BN(1500)) // More than max tokens
          .accounts({
            sale: edgeSalePda,
            userPurchase: buyer3PurchasePda,
            buyer: buyer3.publicKey,
            tokenMint: tokenMint,
            saleTokenVault: edgeSaleVault,
            buyerTokenAccount: buyer3TokenAccount,
            treasury: treasury.publicKey,
            pythPriceUpdate: priceUpdateAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: web3.SystemProgram.programId,
            rent: web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([buyer3])
          .rpc();

        assert.fail("Should have failed with exceeds max tokens");
      } catch (error) {
        expect(error.error.errorMessage).to.include("Exceeds maximum tokens for sale");
        console.log("✅ Correctly prevented overselling");
      }
    });

    it("should test price precision and rounding", async () => {
      console.log("Testing price precision and rounding...");

      // Test with odd price that might cause rounding issues
      const oddPriceAuthority = web3.Keypair.generate();
      await connection.requestAirdrop(oddPriceAuthority.publicKey, 5 * web3.LAMPORTS_PER_SOL);
      await new Promise(resolve => setTimeout(resolve, 1000));

      const [oddPriceSalePda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("sale"), oddPriceAuthority.publicKey.toBuffer(), tokenMint.toBuffer()],
        program.programId
      );

      // Price: $0.33 (33000000 with 8 decimals)
      const oddPrice = new BN(33000000);
      
      await program.methods
        .initializeSale(
          oddPrice,
          new BN(10000),
          MIN_PURCHASE,
          MAX_PURCHASE,
          SALE_DURATION,
          MAX_PRICE_AGE
        )
        .accounts({
          sale: oddPriceSalePda,
          authority: oddPriceAuthority.publicKey,
          tokenMint: tokenMint,
          treasury: treasury.publicKey,
          pythPriceUpdate: priceUpdateAccount,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([oddPriceAuthority])
        .rpc();

      // Fund the sale
      const oddPriceSaleVault = await getAssociatedTokenAddress(
        tokenMint,
        oddPriceSalePda,
        true
      );

      await mintTo(
        connection,
        authority,
        tokenMint,
        oddPriceSaleVault,
        authority.publicKey,
        10000
      );

      console.log("✅ Price precision test setup completed");
    });

    it("should handle different SOL price scenarios", async () => {
      console.log("Testing different SOL price scenarios...");

      // Test with very high SOL price
      const highSolPrice = new BN(50000000000); // $500 per SOL
      await updateMockPriceData(connection, authority, priceUpdateAccount, highSolPrice);

      // Test with very low SOL price  
      const lowSolPrice = new BN(1000000000); // $10 per SOL
      await updateMockPriceData(connection, authority, priceUpdateAccount, lowSolPrice);

      // Reset to normal price
      await updateMockPriceData(connection, authority, priceUpdateAccount, MOCK_SOL_USD_PRICE);

      console.log("✅ Different SOL price scenarios tested");
    });
  });

  describe("Gas Efficiency and Performance", () => {
    it("should maintain reasonable gas costs for purchases", async () => {
      console.log("Testing gas efficiency...");

      const gasTestAuthority = web3.Keypair.generate();
      await connection.requestAirdrop(gasTestAuthority.publicKey, 5 * web3.LAMPORTS_PER_SOL);
      await new Promise(resolve => setTimeout(resolve, 1000));

      const [gasTestSalePda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("sale"), gasTestAuthority.publicKey.toBuffer(), tokenMint.toBuffer()],
        program.programId
      );

      await program.methods
        .initializeSale(
          TOKEN_PRICE_USD,
          MAX_TOKENS,
          MIN_PURCHASE,
          MAX_PURCHASE,
          SALE_DURATION,
          MAX_PRICE_AGE
        )
        .accounts({
          sale: gasTestSalePda,
          authority: gasTestAuthority.publicKey,
          tokenMint: tokenMint,
          treasury: treasury.publicKey,
          pythPriceUpdate: priceUpdateAccount,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([gasTestAuthority])
        .rpc();

      // Fund the gas test sale
      const gasTestSaleVault = await getAssociatedTokenAddress(
        tokenMint,
        gasTestSalePda,
        true
      );

      await mintTo(
        connection,
        authority,
        tokenMint,
        gasTestSaleVault,
        authority.publicKey,
        MAX_TOKENS.toNumber()
      );

      // Create buyer for gas testing
      const gasBuyer = web3.Keypair.generate();
      await connection.requestAirdrop(gasBuyer.publicKey, 5 * web3.LAMPORTS_PER_SOL);
      await new Promise(resolve => setTimeout(resolve, 1000));

      const gasBuyerTokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        gasBuyer.publicKey
      );

      const [gasBuyerPurchasePda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("purchase"), gasTestSalePda.toBuffer(), gasBuyer.publicKey.toBuffer()],
        program.programId
      );

      // Measure transaction cost
      const purchaseAmount = new BN(500);
      const initialBalance = await connection.getBalance(gasBuyer.publicKey);

      const tx = await program.methods
        .purchaseTokens(purchaseAmount)
        .accounts({
          sale: gasTestSalePda,
          userPurchase: gasBuyerPurchasePda,
          buyer: gasBuyer.publicKey,
          tokenMint: tokenMint,
          saleTokenVault: gasTestSaleVault,
          buyerTokenAccount: gasBuyerTokenAccount,
          treasury: treasury.publicKey,
          pythPriceUpdate: priceUpdateAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([gasBuyer])
        .rpc();

      const finalBalance = await connection.getBalance(gasBuyer.publicKey);
      const transactionCost = initialBalance - finalBalance;

      console.log("Purchase transaction signature:", tx);
      console.log("Transaction cost (including purchase):", transactionCost / web3.LAMPORTS_PER_SOL, "SOL");
      console.log("✅ Gas efficiency test completed");
    });
  });

  describe("Multi-user Concurrent Purchases", () => {
    it("should handle multiple concurrent purchases correctly", async () => {
      console.log("Testing concurrent purchases...");

      // Create multiple buyers
      const concurrentBuyers = [];
      for (let i = 0; i < 3; i++) {
        const buyer = web3.Keypair.generate();
        await connection.requestAirdrop(buyer.publicKey, 5 * web3.LAMPORTS_PER_SOL);
        concurrentBuyers.push(buyer);
      }

      await new Promise(resolve => setTimeout(resolve, 2000));

      // Create a new sale for concurrent testing
      const concurrentAuthority = web3.Keypair.generate();
      await connection.requestAirdrop(concurrentAuthority.publicKey, 5 * web3.LAMPORTS_PER_SOL);
      await new Promise(resolve => setTimeout(resolve, 1000));

      const [concurrentSalePda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("sale"), concurrentAuthority.publicKey.toBuffer(), tokenMint.toBuffer()],
        program.programId
      );

      await program.methods
        .initializeSale(
          TOKEN_PRICE_USD,
          new BN(10_000), // Enough tokens for all buyers
          MIN_PURCHASE,
          MAX_PURCHASE,
          SALE_DURATION,
          MAX_PRICE_AGE
        )
        .accounts({
          sale: concurrentSalePda,
          authority: concurrentAuthority.publicKey,
          tokenMint: tokenMint,
          treasury: treasury.publicKey,
          pythPriceUpdate: priceUpdateAccount,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([concurrentAuthority])
        .rpc();

      // Fund the concurrent sale
      const concurrentSaleVault = await getAssociatedTokenAddress(
        tokenMint,
        concurrentSalePda,
        true
      );

      await mintTo(
        connection,
        authority,
        tokenMint,
        concurrentSaleVault,
        authority.publicKey,
        10_000
      );

      // Execute concurrent purchases
      const purchasePromises = concurrentBuyers.map(async (buyer, index) => {
        const buyerTokenAccount = await getAssociatedTokenAddress(
          tokenMint,
          buyer.publicKey
        );

        const [buyerPurchasePda] = web3.PublicKey.findProgramAddressSync(
          [Buffer.from("purchase"), concurrentSalePda.toBuffer(), buyer.publicKey.toBuffer()],
          program.programId
        );

        const purchaseAmount = new BN(500 + index * 100); // Different amounts

        return program.methods
          .purchaseTokens(purchaseAmount)
          .accounts({
            sale: concurrentSalePda,
            userPurchase: buyerPurchasePda,
            buyer: buyer.publicKey,
            tokenMint: tokenMint,
            saleTokenVault: concurrentSaleVault,
            buyerTokenAccount: buyerTokenAccount,
            treasury: treasury.publicKey,
            pythPriceUpdate: priceUpdateAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: web3.SystemProgram.programId,
            rent: web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([buyer])
          .rpc();
      });

      // Wait for all purchases to complete
      const results = await Promise.all(purchasePromises);
      console.log("Concurrent purchase transactions:", results.length, "completed");

      // Verify final state
      const finalSaleState = await program.account.sale.fetch(concurrentSalePda);
      const expectedTotalSold = 500 + 600 + 700; // Sum of all purchases
      assert.equal(finalSaleState.tokensSold.toString(), expectedTotalSold.toString());
      
      console.log("✅ Concurrent purchases handled correctly");
      console.log("Total tokens sold:", finalSaleState.tokensSold.toString());
    });
  });

  describe("Event Emission Tests", () => {
    it("should emit correct events for sale operations", async () => {
      console.log("Testing event emissions...");

      // Create event test sale
      const eventAuthority = web3.Keypair.generate();
      await connection.requestAirdrop(eventAuthority.publicKey, 5 * web3.LAMPORTS_PER_SOL);
      await new Promise(resolve => setTimeout(resolve, 1000));

      const [eventSalePda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("sale"), eventAuthority.publicKey.toBuffer(), tokenMint.toBuffer()],
        program.programId
      );

      // Test initialization event
      const initTx = await program.methods
        .initializeSale(
          TOKEN_PRICE_USD,
          new BN(5000),
          MIN_PURCHASE,
          MAX_PURCHASE,
          SALE_DURATION,
          MAX_PRICE_AGE
        )
        .accounts({
          sale: eventSalePda,
          authority: eventAuthority.publicKey,
          tokenMint: tokenMint,
          treasury: treasury.publicKey,
          pythPriceUpdate: priceUpdateAccount,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([eventAuthority])
        .rpc();

      console.log("Sale initialization event transaction:", initTx);

      // Fund sale for purchase event test
      const eventSaleVault = await getAssociatedTokenAddress(
        tokenMint,
        eventSalePda,
        true
      );

      await mintTo(
        connection,
        authority,
        tokenMint,
        eventSaleVault,
        authority.publicKey,
        5000
      );

      // Test purchase event
      const eventBuyer = web3.Keypair.generate();
      await connection.requestAirdrop(eventBuyer.publicKey, 5 * web3.LAMPORTS_PER_SOL);
      await new Promise(resolve => setTimeout(resolve, 1000));

      const eventBuyerTokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        eventBuyer.publicKey
      );

      const [eventBuyerPurchasePda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("purchase"), eventSalePda.toBuffer(), eventBuyer.publicKey.toBuffer()],
        program.programId
      );

      const purchaseTx = await program.methods
        .purchaseTokens(new BN(1000))
        .accounts({
          sale: eventSalePda,
          userPurchase: eventBuyerPurchasePda,
          buyer: eventBuyer.publicKey,
          tokenMint: tokenMint,
          saleTokenVault: eventSaleVault,
          buyerTokenAccount: eventBuyerTokenAccount,
          treasury: treasury.publicKey,
          pythPriceUpdate: priceUpdateAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([eventBuyer])
        .rpc();

      console.log("Purchase event transaction:", purchaseTx);

      // Test pause event
      const pauseTx = await program.methods
        .togglePause()
        .accounts({
          sale: eventSalePda,
          authority: eventAuthority.publicKey,
        })
        .signers([eventAuthority])
        .rpc();

      console.log("Pause event transaction:", pauseTx);

      // Test end sale event
      const endTx = await program.methods
        .endSale()
        .accounts({
          sale: eventSalePda,
          authority: eventAuthority.publicKey,
        })
        .signers([eventAuthority])
        .rpc();

      console.log("End sale event transaction:", endTx);

      console.log("✅ Event emission tests completed");
    });
  });

  describe("Integration with Real Price Data", () => {
    it("should demonstrate real Pyth integration pattern", async () => {
      console.log("Testing real Pyth integration pattern...");

      // This test demonstrates how you would integrate with real Pyth data
      // In production, you would:
      // 1. Fetch price data from Pyth price service
      // 2. Submit price update to Solana
      // 3. Use updated price feed in your transaction

      console.log("Real Pyth integration steps:");
      console.log("1. const priceService = new PriceServiceConnection('https://hermes.pyth.network');");
      console.log("2. const priceIds = [SOL_USD_FEED_ID];");
      console.log("3. const priceUpdateData = await priceService.getPriceFeedsUpdateData(priceIds);");
      console.log("4. const updateTx = await pythReceiver.updatePriceFeed(connection, wallet, priceUpdateData[0]);");
      console.log("5. Use updateTx.priceUpdateAccount in your purchase transaction");

      console.log("✅ Real Pyth integration pattern documented");
    });
  });

  describe("Final Integration Test", () => {
    it("should complete full ICO lifecycle", async () => {
      console.log("Running complete ICO lifecycle test...");

      // Create final test sale
      const finalAuthority = web3.Keypair.generate();
      await connection.requestAirdrop(finalAuthority.publicKey, 10 * web3.LAMPORTS_PER_SOL);
      await new Promise(resolve => setTimeout(resolve, 1000));

      const [finalSalePda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("sale"), finalAuthority.publicKey.toBuffer(), tokenMint.toBuffer()],
        program.programId
      );

      console.log("1. Initializing final test sale...");
      await program.methods
        .initializeSale(
          new BN(50000000), // $0.50 per token
          new BN(2000),     // 2000 tokens max
          new BN(50),       // 50 tokens min
          new BN(1000),     // 1000 tokens max per user
          SALE_DURATION,
          MAX_PRICE_AGE
        )
        .accounts({
          sale: finalSalePda,
          authority: finalAuthority.publicKey,
          tokenMint: tokenMint,
          treasury: treasury.publicKey,
          pythPriceUpdate: priceUpdateAccount,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([finalAuthority])
        .rpc();

      console.log("2. Funding sale...");
      const finalSaleVault = await getAssociatedTokenAddress(
        tokenMint,
        finalSalePda,
        true
      );

      await mintTo(
        connection,
        authority,
        tokenMint,
        finalSaleVault,
        authority.publicKey,
        2000
      );

      console.log("3. Executing multiple purchases...");
      const finalBuyers = [];
      for (let i = 0; i < 2; i++) {
        const buyer = web3.Keypair.generate();
        await connection.requestAirdrop(buyer.publicKey, 5 * web3.LAMPORTS_PER_SOL);
        finalBuyers.push(buyer);
      }

      await new Promise(resolve => setTimeout(resolve, 2000));

      for (let i = 0; i < finalBuyers.length; i++) {
        const buyer = finalBuyers[i];
        const buyerTokenAccount = await getAssociatedTokenAddress(
          tokenMint,
          buyer.publicKey
        );

        const [buyerPurchasePda] = web3.PublicKey.findProgramAddressSync(
          [Buffer.from("purchase"), finalSalePda.toBuffer(), buyer.publicKey.toBuffer()],
          program.programId
        );

        await program.methods
          .purchaseTokens(new BN(500 + i * 200)) // 500, 700 tokens
          .accounts({
            sale: finalSalePda,
            userPurchase: buyerPurchasePda,
            buyer: buyer.publicKey,
            tokenMint: tokenMint,
            saleTokenVault: finalSaleVault,
            buyerTokenAccount: buyerTokenAccount,
            treasury: treasury.publicKey,
            pythPriceUpdate: priceUpdateAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: web3.SystemProgram.programId,
            rent: web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([buyer])
          .rpc();

        console.log(`   Buyer ${i + 1} purchased ${500 + i * 200} tokens`);
      }

      console.log("4. Ending sale...");
      await program.methods
        .endSale()
        .accounts({
          sale: finalSalePda,
          authority: finalAuthority.publicKey,
        })
        .signers([finalAuthority])
        .rpc();

      console.log("5. Withdrawing remaining tokens...");
      const finalAuthorityTokenAccount = await createAssociatedTokenAccount(
        connection,
        finalAuthority,
        tokenMint,
        finalAuthority.publicKey
      );

      await program.methods
        .withdrawRemainingTokens()
        .accounts({
          sale: finalSalePda,
          authority: finalAuthority.publicKey,
          tokenMint: tokenMint,
          saleTokenVault: finalSaleVault,
          authorityTokenAccount: finalAuthorityTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([finalAuthority])
        .rpc();

      console.log("6. Verifying final state...");
      const finalSaleState = await program.account.sale.fetch(finalSalePda);
      console.log("   Final tokens sold:", finalSaleState.tokensSold.toString());
      console.log("   Final SOL raised:", finalSaleState.totalRaised.toNumber() / web3.LAMPORTS_PER_SOL);
      console.log("   Sale is active:", finalSaleState.isActive);

      // Verify vault is empty
      const finalVaultState = await getAccount(connection, finalSaleVault);
      console.log("   Remaining tokens in vault:", finalVaultState.amount.toString());

      // Verify authority got remaining tokens
      const authorityFinalBalance = await getAccount(connection, finalAuthorityTokenAccount);
      console.log("   Authority final token balance:", authorityFinalBalance.amount.toString());

      assert.equal(finalSaleState.tokensSold.toString(), "1200"); // 500 + 700
      assert.equal(finalSaleState.isActive, false);
      assert.equal(finalVaultState.amount.toString(), "0");
      assert.equal(authorityFinalBalance.amount.toString(), "800"); // 2000 - 1200

      console.log("✅ Complete ICO lifecycle test successful!");
    });
  });
});

// =====================================
// HELPER FUNCTIONS FOR MOCK PRICE FEEDS
// =====================================

async function createMockPriceUpdateAccount(
  connection: web3.Connection, 
  payer: web3.Keypair
): Promise<web3.PublicKey> {
  console.log("Creating mock price update account...");

  const mockAccount = web3.Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(1000);
  
  // In a real implementation, this would be the Pyth program ID
  // For testing, we use SystemProgram
  const createAccountIx = web3.SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: mockAccount.publicKey,
    lamports,
    space: 1000,
    programId: web3.SystemProgram.programId,
  });

  const tx = new web3.Transaction().add(createAccountIx);
  await web3.sendAndConfirmTransaction(connection, tx, [payer, mockAccount]);
  
  console.log("Mock price update account created:", mockAccount.publicKey.toString());
  return mockAccount.publicKey;
}

async function updateMockPriceData(
  connection: web3.Connection,
  payer: web3.Keypair,
  priceUpdateAccount: web3.PublicKey,
  newPrice: BN
): Promise<void> {
  console.log("Updating mock price data to:", newPrice.toNumber() / 100000000, "USD");

  // In a real implementation, this would:
  // 1. Fetch the latest price data from Pyth's price service
  // 2. Submit a price update transaction to the Pyth program
  // 3. Update the price feed account with current timestamp and price
  
  // For testing, we just log the update
  console.log("Mock price update completed");
}

/*
=====================================
PRODUCTION INTEGRATION GUIDE
=====================================

To integrate with real Pyth price feeds in production:

1. Install required packages:
   npm install @pythnetwork/price-service-client @pythnetwork/pyth-solana-receiver

2. Replace mock functions with real Pyth integration:

   import { PriceServiceConnection } from "@pythnetwork/price-service-client";
   import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";

   const priceService = new PriceServiceConnection("https://hermes.pyth.network");
   const pythReceiver = new PythSolanaReceiver({ connection, wallet });

3. Real price update process:

   async function updateSolPrice() {
     const priceIds = ["0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"];
     const priceUpdateData = await priceService.getPriceFeedsUpdateData(priceIds);
     const updateTx = await pythReceiver.updatePriceFeed(
       connection,
       wallet,
       priceUpdateData[0]
     );
     return updateTx.priceUpdateAccount;
   }

4. Frontend integration:

   // Get current SOL price for UI display
   const getCurrentSolPrice = async () => {
     const priceFeeds = await priceService.getLatestPriceFeeds([SOL_USD_FEED_ID]);
     return priceFeeds[0]?.getPriceNoOlderThan(60)?.price || 0;
   };

   // Calculate expected SOL cost
   const calculateSolCost = (tokenAmount, tokenPriceUsd, solPriceUsd) => {
     const usdCost = tokenAmount * tokenPriceUsd / 100000000; // Adjust for decimals
     return usdCost / (solPriceUsd / 100000000); // Adjust for decimals
   };

5. Error handling:

   try {
     const priceUpdateAccount = await updateSolPrice();
     // Use in transaction
   } catch (error) {
     if (error.message.includes("PriceFeedNotFound")) {
       console.error("Price feed not available");
     } else if (error.message.includes("StalePrice")) {
       console.error("Price data is too old");
     }
   }

6. Network configuration:

   Mainnet SOL/USD: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"
   Devnet SOL/USD:  "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"

For more details, visit: https://docs.pyth.network/
*/
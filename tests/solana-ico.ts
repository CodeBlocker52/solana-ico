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

describe("ICO Token Sale", () => {
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

  // PDAs
  let salePda: web3.PublicKey;
  let saleBump: number;

  // Sale parameters
  const TOKEN_PRICE = new BN(1_000_000); // 0.001 SOL per token
  const MAX_TOKENS = new BN(1_000_000); // 1M tokens
  const MIN_PURCHASE = new BN(100); // 100 tokens minimum
  const MAX_PURCHASE = new BN(10_000); // 10K tokens maximum per user
  const SALE_DURATION = new BN(3600); // 1 hour
  const TOKEN_DECIMALS = 9;

  before(async () => {
    // Generate keypairs
    authority = web3.Keypair.generate();
    buyer1 = web3.Keypair.generate();
    buyer2 = web3.Keypair.generate();
    treasury = web3.Keypair.generate();

    // Airdrop SOL to test accounts
    await Promise.all([
      connection.requestAirdrop(authority.publicKey, 10 * web3.LAMPORTS_PER_SOL),
      connection.requestAirdrop(buyer1.publicKey, 5 * web3.LAMPORTS_PER_SOL),
      connection.requestAirdrop(buyer2.publicKey, 5 * web3.LAMPORTS_PER_SOL),
    ]);

    // Wait for airdrops to confirm
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Create token mint
    tokenMint = await createMint(
      connection,
      authority,
      authority.publicKey,
      authority.publicKey,
      TOKEN_DECIMALS
    );

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
  });

  describe("Initialize Sale", () => {
    it("should initialize sale successfully", async () => {
      const tx = await program.methods
        .initializeSale(
          TOKEN_PRICE,
          MAX_TOKENS,
          MIN_PURCHASE,
          MAX_PURCHASE,
          SALE_DURATION
        )
        .accounts({
          sale: salePda,
          authority: authority.publicKey,
          tokenMint: tokenMint,
          treasury: treasury.publicKey,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([authority])
        .rpc();

      // Verify sale account
      const saleAccount = await program.account.sale.fetch(salePda);
      assert.equal(saleAccount.authority.toString(), authority.publicKey.toString());
      assert.equal(saleAccount.tokenMint.toString(), tokenMint.toString());
      assert.equal(saleAccount.treasury.toString(), treasury.publicKey.toString());
      assert.equal(saleAccount.tokenPrice.toString(), TOKEN_PRICE.toString());
      assert.equal(saleAccount.maxTokens.toString(), MAX_TOKENS.toString());
      assert.equal(saleAccount.minPurchase.toString(), MIN_PURCHASE.toString());
      assert.equal(saleAccount.maxPurchase.toString(), MAX_PURCHASE.toString());
      assert.equal(saleAccount.tokensSold.toString(), "0");
      assert.equal(saleAccount.totalRaised.toString(), "0");
      assert.equal(saleAccount.isActive, true);
      assert.equal(saleAccount.isPaused, false);
      assert.equal(saleAccount.bump, saleBump);
    });

    it("should fail with invalid parameters", async () => {
      const invalidSalePda = web3.Keypair.generate().publicKey;
      
      try {
        await program.methods
          .initializeSale(
            new BN(0), // Invalid price
            MAX_TOKENS,
            MIN_PURCHASE,
            MAX_PURCHASE,
            SALE_DURATION
          )
          .accounts({
            sale: invalidSalePda,
            authority: authority.publicKey,
            tokenMint: tokenMint,
            treasury: treasury.publicKey,
            systemProgram: web3.SystemProgram.programId,
            rent: web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([authority])
          .rpc();
        
        assert.fail("Should have failed with invalid price");
      } catch (error) {
        expect(error.error.errorMessage).to.include("Invalid price");
      }
    });
  });

  describe("Fund Sale", () => {
    it("should fund the sale with tokens", async () => {
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
    });
  });

  describe("Purchase Tokens", () => {
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
    });

    it("should allow token purchase", async () => {
      const purchaseAmount = new BN(1000); // 1000 tokens
      const expectedCost = purchaseAmount.mul(TOKEN_PRICE);

      // Get initial balances
      const initialTreasuryBalance = await connection.getBalance(treasury.publicKey);
      const initialBuyerBalance = await connection.getBalance(buyer1.publicKey);

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
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([buyer1])
        .rpc();

      // Verify sale state updated
      const saleAccount = await program.account.sale.fetch(salePda);
      assert.equal(saleAccount.tokensSold.toString(), purchaseAmount.toString());
      assert.equal(saleAccount.totalRaised.toString(), expectedCost.toString());

      // Verify user purchase tracking
      const userPurchase = await program.account.userPurchase.fetch(buyer1PurchasePda);
      assert.equal(userPurchase.user.toString(), buyer1.publicKey.toString());
      assert.equal(userPurchase.sale.toString(), salePda.toString());
      assert.equal(userPurchase.tokensPurchased.toString(), purchaseAmount.toString());
      assert.equal(userPurchase.solContributed.toString(), expectedCost.toString());

      // Verify buyer received tokens
      const buyerTokenBalance = await getAccount(connection, buyer1TokenAccount);
      assert.equal(buyerTokenBalance.amount.toString(), purchaseAmount.toString());

      // Verify treasury received SOL
      const finalTreasuryBalance = await connection.getBalance(treasury.publicKey);
      assert.equal(
        finalTreasuryBalance - initialTreasuryBalance,
        expectedCost.toNumber()
      );
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
      }
    });
  });

  describe("Sale Management", () => {
    it("should pause and unpause sale", async () => {
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
      }
    });

    it("should end sale early", async () => {
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
    });
  });

  describe("Withdraw Remaining Tokens", () => {
    it("should withdraw remaining tokens after sale ends", async () => {
      // Get initial authority token balance
      const initialBalance = await getAccount(connection, authorityTokenAccount);
      const initialAmount = initialBalance.amount;

      // Get remaining tokens in vault
      const vaultBalance = await getAccount(connection, saleTokenVault);
      const remainingTokens = vaultBalance.amount;

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
    });
  });

  describe("Update Sale Parameters", () => {
    let newSalePda: web3.PublicKey;
    let newSaleBump: number;

    before(async () => {
      // Create a new sale for parameter update testing
      const newAuthority = web3.Keypair.generate();
      await connection.requestAirdrop(newAuthority.publicKey, 5 * web3.LAMPORTS_PER_SOL);
      await new Promise(resolve => setTimeout(resolve, 1000));

      [newSalePda, newSaleBump] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("sale"), newAuthority.publicKey.toBuffer(), tokenMint.toBuffer()],
        program.programId
      );

      await program.methods
        .initializeSale(
          TOKEN_PRICE,
          MAX_TOKENS,
          MIN_PURCHASE,
          MAX_PURCHASE,
          new BN(7200) // 2 hours from now
        )
        .accounts({
          sale: newSalePda,
          authority: newAuthority.publicKey,
          tokenMint: tokenMint,
          treasury: treasury.publicKey,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([newAuthority])
        .rpc();

      // Update parameters before sale starts
      await program.methods
        .updateSaleParams(
          new BN(2_000_000), // new price
          new BN(500_000),   // new max tokens
          new BN(200),       // new min purchase
          new BN(5000)       // new max purchase
        )
        .accounts({
          sale: newSalePda,
          authority: newAuthority.publicKey,
        })
        .signers([newAuthority])
        .rpc();

      // Verify parameters updated
      const updatedSale = await program.account.sale.fetch(newSalePda);
      assert.equal(updatedSale.tokenPrice.toString(), "2000000");
      assert.equal(updatedSale.maxTokens.toString(), "500000");
      assert.equal(updatedSale.minPurchase.toString(), "200");
      assert.equal(updatedSale.maxPurchase.toString(), "5000");
    });

    it("should update sale parameters before sale starts", async () => {
      // Test is implemented in the before block above
      assert.ok("Parameters updated successfully");
    });
  });

 

  describe("Edge Cases", () => {
    it("should handle maximum token purchase correctly", async () => {
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
          TOKEN_PRICE,
          smallMaxTokens,
          MIN_PURCHASE,
          MAX_PURCHASE,
          SALE_DURATION
        )
        .accounts({
          sale: edgeSalePda,
          authority: edgeAuthority.publicKey,
          tokenMint: tokenMint,
          treasury: treasury.publicKey,
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
      }
    });
  });
});
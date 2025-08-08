use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer as SystemTransfer};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};
use pyth_solana_receiver_sdk::price_update::{get_feed_id_from_hex, PriceUpdateV2};

declare_id!("GsShB9qNbSRFFDCZjr5zMFraTV3wWgbjuXQiiJ6AnVq4");

// Pyth SOL/USD price feed ID (mainnet)
// For devnet, use: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"
const SOL_USD_PRICE_FEED_ID: &str = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

#[program]
pub mod ico_token_sale {
    use super::*;

    /// Initialize the ICO sale with parameters
    pub fn initialize_sale(
        ctx: Context<InitializeSale>,
        token_price_usd: u64,  // Price per token in USD (with 8 decimals, e.g., 100000000 = $1.00)
        max_tokens: u64,       // Maximum tokens to sell
        min_purchase: u64,     // Minimum token purchase amount
        max_purchase: u64,     // Maximum token purchase per wallet
        sale_duration: i64,    // Sale duration in seconds
        max_age: u64,          // Maximum age of price feed in seconds
    ) -> Result<()> {
        let sale = &mut ctx.accounts.sale;
        let clock = Clock::get()?;

        require!(token_price_usd > 0, ErrorCode::InvalidPrice);
        require!(max_tokens > 0, ErrorCode::InvalidAmount);
        require!(
            min_purchase > 0 && min_purchase <= max_purchase,
            ErrorCode::InvalidPurchaseLimit
        );
        require!(sale_duration > 0, ErrorCode::InvalidDuration);
        require!(max_age > 0 && max_age <= 3600, ErrorCode::InvalidMaxAge); // Max 1 hour

        sale.authority = ctx.accounts.authority.key();
        sale.token_mint = ctx.accounts.token_mint.key();
        sale.treasury = ctx.accounts.treasury.key();
        sale.pyth_price_update = ctx.accounts.pyth_price_update.key();
        sale.token_price_usd = token_price_usd;
        sale.max_tokens = max_tokens;
        sale.min_purchase = min_purchase;
        sale.max_purchase = max_purchase;
        sale.tokens_sold = 0;
        sale.total_raised = 0;
        sale.start_time = clock.unix_timestamp;
        sale.end_time = clock.unix_timestamp + sale_duration;
        sale.max_price_age = max_age;
        sale.is_active = true;
        sale.is_paused = false;
        sale.bump = ctx.bumps.sale;

        emit!(SaleInitialized {
            sale: sale.key(),
            authority: sale.authority,
            token_mint: sale.token_mint,
            token_price_usd,
            max_tokens,
            start_time: sale.start_time,
            end_time: sale.end_time,
        });

        Ok(())
    }

    /// Purchase tokens during the ICO
    pub fn purchase_tokens(ctx: Context<PurchaseTokens>, token_amount: u64) -> Result<()> {
        let sale = &mut ctx.accounts.sale;
        let clock = Clock::get()?;

        // Validate sale conditions
        require!(sale.is_active, ErrorCode::SaleInactive);
        require!(!sale.is_paused, ErrorCode::SalePaused);
        require!(
            clock.unix_timestamp >= sale.start_time && clock.unix_timestamp <= sale.end_time,
            ErrorCode::SaleNotActive
        );

        // Validate purchase amount
        require!(
            token_amount >= sale.min_purchase,
            ErrorCode::BelowMinimumPurchase
        );
        require!(
            token_amount <= sale.max_purchase,
            ErrorCode::ExceedsMaximumPurchase
        );
        require!(
            sale.tokens_sold + token_amount <= sale.max_tokens,
            ErrorCode::ExceedsMaxTokens
        );

        // Get SOL/USD price from Pyth
        let price_update = &ctx.accounts.pyth_price_update;
        let sol_usd_price = get_sol_usd_price(price_update, sale.max_price_age, clock.unix_timestamp)?;

        // Calculate SOL cost
        // token_price_usd has 8 decimals, sol_usd_price has 8 decimals
        // Result should be in lamports (9 decimals for SOL)
        let usd_cost = token_amount
            .checked_mul(sale.token_price_usd)
            .ok_or(ErrorCode::MathOverflow)?;

        let sol_cost = usd_cost
            .checked_mul(1_000_000_000) // Convert to lamports (9 decimals)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(sol_usd_price)
            .ok_or(ErrorCode::MathOverflow)?;

        // Check user's purchase limit
        let user_purchase = &mut ctx.accounts.user_purchase;
        require!(
            user_purchase.tokens_purchased + token_amount <= sale.max_purchase,
            ErrorCode::ExceedsUserLimit
        );

        // Transfer SOL from buyer to treasury
        let transfer_instruction = SystemTransfer {
            from: ctx.accounts.buyer.to_account_info(),
            to: ctx.accounts.treasury.to_account_info(),
        };

        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                transfer_instruction,
            ),
            sol_cost,
        )?;

        // Transfer tokens from sale vault to buyer
        let seeds = &[
            b"sale",
            sale.authority.as_ref(),
            sale.token_mint.as_ref(),
            &[sale.bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.sale_token_vault.to_account_info(),
            to: ctx.accounts.buyer_token_account.to_account_info(),
            authority: sale.to_account_info(),
        };

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer,
            ),
            token_amount,
        )?;

        // Update state
        sale.tokens_sold += token_amount;
        sale.total_raised += sol_cost;
        user_purchase.tokens_purchased += token_amount;
        user_purchase.sol_contributed += sol_cost;

        emit!(TokensPurchased {
            buyer: ctx.accounts.buyer.key(),
            token_amount,
            sol_cost,
            sol_usd_price,
            total_tokens_sold: sale.tokens_sold,
            total_raised: sale.total_raised,
        });

        Ok(())
    }

    /// Pause or unpause the sale (authority only)
    pub fn toggle_pause(ctx: Context<TogglePause>) -> Result<()> {
        let sale = &mut ctx.accounts.sale;
        sale.is_paused = !sale.is_paused;

        emit!(SaleToggled {
            sale: sale.key(),
            is_paused: sale.is_paused,
        });

        Ok(())
    }

    /// End the sale early (authority only)
    pub fn end_sale(ctx: Context<EndSale>) -> Result<()> {
        let sale = &mut ctx.accounts.sale;
        let clock = Clock::get()?;

        sale.is_active = false;
        sale.end_time = clock.unix_timestamp;

        emit!(SaleEnded {
            sale: sale.key(),
            tokens_sold: sale.tokens_sold,
            total_raised: sale.total_raised,
            end_time: sale.end_time,
        });

        Ok(())
    }

    /// Withdraw remaining tokens after sale ends (authority only)
    pub fn withdraw_remaining_tokens(ctx: Context<WithdrawTokens>) -> Result<()> {
        let sale = &ctx.accounts.sale;
        let clock = Clock::get()?;

        require!(
            !sale.is_active || clock.unix_timestamp > sale.end_time,
            ErrorCode::SaleStillActive
        );

        let remaining_tokens = ctx.accounts.sale_token_vault.amount;

        if remaining_tokens > 0 {
            let seeds = &[
                b"sale",
                sale.authority.as_ref(),
                sale.token_mint.as_ref(),
                &[sale.bump],
            ];
            let signer = &[&seeds[..]];

            let cpi_accounts = Transfer {
                from: ctx.accounts.sale_token_vault.to_account_info(),
                to: ctx.accounts.authority_token_account.to_account_info(),
                authority: sale.to_account_info(),
            };

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_accounts,
                    signer,
                ),
                remaining_tokens,
            )?;
        }

        emit!(TokensWithdrawn {
            authority: ctx.accounts.authority.key(),
            amount: remaining_tokens,
        });

        Ok(())
    }

    /// Update sale parameters (authority only, before sale starts)
    pub fn update_sale_params(
        ctx: Context<UpdateSaleParams>,
        new_price_usd: Option<u64>,
        new_max_tokens: Option<u64>,
        new_min_purchase: Option<u64>,
        new_max_purchase: Option<u64>,
        new_max_age: Option<u64>,
    ) -> Result<()> {
        let sale = &mut ctx.accounts.sale;
        let clock = Clock::get()?;

        require!(
            clock.unix_timestamp < sale.start_time,
            ErrorCode::SaleAlreadyStarted
        );

        if let Some(price) = new_price_usd {
            require!(price > 0, ErrorCode::InvalidPrice);
            sale.token_price_usd = price;
        }

        if let Some(max_tokens) = new_max_tokens {
            require!(max_tokens > 0, ErrorCode::InvalidAmount);
            sale.max_tokens = max_tokens;
        }

        if let Some(min_purchase) = new_min_purchase {
            require!(min_purchase > 0, ErrorCode::InvalidPurchaseLimit);
            sale.min_purchase = min_purchase;
        }

        if let Some(max_purchase) = new_max_purchase {
            require!(max_purchase > 0, ErrorCode::InvalidPurchaseLimit);
            sale.max_purchase = max_purchase;
        }

        if let Some(max_age) = new_max_age {
            require!(max_age > 0 && max_age <= 3600, ErrorCode::InvalidMaxAge);
            sale.max_price_age = max_age;
        }

        require!(
            sale.min_purchase <= sale.max_purchase,
            ErrorCode::InvalidPurchaseLimit
        );

        emit!(SaleParamsUpdated {
            sale: sale.key(),
            token_price_usd: sale.token_price_usd,
            max_tokens: sale.max_tokens,
            min_purchase: sale.min_purchase,
            max_purchase: sale.max_purchase,
            max_price_age: sale.max_price_age,
        });

        Ok(())
    }
}

// Helper function to get SOL/USD price from Pyth
fn get_sol_usd_price(price_update: &PriceUpdateV2, max_age: u64, current_time: i64) -> Result<u64> {
    let sol_usd_feed_id = get_feed_id_from_hex(SOL_USD_PRICE_FEED_ID)?;
    let price_feed = price_update.get_price_no_older_than(&Clock::get()?, max_age, &sol_usd_feed_id)?;
    
    require!(price_feed.price > 0, ErrorCode::InvalidPriceData);
    
    // Convert price to u64 with 8 decimal places
    // Pyth price comes with different exponent, normalize to 8 decimals
    let price = if price_feed.exponent >= -8 {
        (price_feed.price as u64) * 10_u64.pow((price_feed.exponent + 8) as u32)
    } else {
        (price_feed.price as u64) / 10_u64.pow((-price_feed.exponent - 8) as u32)
    };
    
    Ok(price)
}

#[derive(Accounts)]
pub struct InitializeSale<'info> {
    #[account(
        init,
        payer = authority,
        space = Sale::INIT_SPACE,
        seeds = [b"sale", authority.key().as_ref(), token_mint.key().as_ref()],
        bump
    )]
    pub sale: Account<'info, Sale>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_mint: Account<'info, Mint>,

    /// CHECK: Treasury account to receive SOL payments
    pub treasury: AccountInfo<'info>,

    pub pyth_price_update: Account<'info, PriceUpdateV2>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct PurchaseTokens<'info> {
    #[account(
        mut,
        seeds = [b"sale", sale.authority.as_ref(), token_mint.key().as_ref()],
        bump = sale.bump,
        has_one = token_mint @ ErrorCode::InvalidTokenMint,
        has_one = pyth_price_update @ ErrorCode::InvalidPriceUpdate
    )]
    pub sale: Account<'info, Sale>,

    #[account(
        init_if_needed,
        payer = buyer,
        space = 8 + UserPurchase::INIT_SPACE,
        seeds = [b"purchase", sale.key().as_ref(), buyer.key().as_ref()],
        bump
    )]
    pub user_purchase: Account<'info, UserPurchase>,

    #[account(mut)]
    pub buyer: Signer<'info>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = sale,
    )]
    pub sale_token_vault: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = token_mint,
        associated_token::authority = buyer,
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    /// CHECK: Treasury account (validated in sale state)
    #[account(mut, address = sale.treasury)]
    pub treasury: AccountInfo<'info>,

    pub pyth_price_update: Account<'info, PriceUpdateV2>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct TogglePause<'info> {
    #[account(
        mut,
        seeds = [b"sale", authority.key().as_ref(), sale.token_mint.as_ref()],
        bump = sale.bump,
        has_one = authority @ ErrorCode::Unauthorized
    )]
    pub sale: Account<'info, Sale>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct EndSale<'info> {
    #[account(
        mut,
        seeds = [b"sale", authority.key().as_ref(), sale.token_mint.as_ref()],
        bump = sale.bump,
        has_one = authority @ ErrorCode::Unauthorized
    )]
    pub sale: Account<'info, Sale>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct WithdrawTokens<'info> {
    #[account(
        seeds = [b"sale", authority.key().as_ref(), token_mint.key().as_ref()],
        bump = sale.bump,
        has_one = authority @ ErrorCode::Unauthorized,
        has_one = token_mint @ ErrorCode::InvalidTokenMint
    )]
    pub sale: Account<'info, Sale>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = sale,
    )]
    pub sale_token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = authority,
    )]
    pub authority_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateSaleParams<'info> {
    #[account(
        mut,
        seeds = [b"sale", authority.key().as_ref(), sale.token_mint.as_ref()],
        bump = sale.bump,
        has_one = authority @ ErrorCode::Unauthorized
    )]
    pub sale: Account<'info, Sale>,

    pub authority: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Sale {
    pub authority: Pubkey,
    pub token_mint: Pubkey,
    pub treasury: Pubkey,
    pub pyth_price_update: Pubkey,
    pub token_price_usd: u64,    // Price per token in USD (8 decimals)
    pub max_tokens: u64,
    pub min_purchase: u64,
    pub max_purchase: u64,
    pub tokens_sold: u64,
    pub total_raised: u64,       // Total SOL raised in lamports
    pub start_time: i64,
    pub end_time: i64,
    pub max_price_age: u64,      // Maximum age of price feed in seconds
    pub is_active: bool,
    pub is_paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserPurchase {
    pub user: Pubkey,
    pub sale: Pubkey,
    pub tokens_purchased: u64,
    pub sol_contributed: u64,
    pub bump: u8,
}

#[event]
pub struct SaleInitialized {
    pub sale: Pubkey,
    pub authority: Pubkey,
    pub token_mint: Pubkey,
    pub token_price_usd: u64,
    pub max_tokens: u64,
    pub start_time: i64,
    pub end_time: i64,
}

#[event]
pub struct TokensPurchased {
    pub buyer: Pubkey,
    pub token_amount: u64,
    pub sol_cost: u64,
    pub sol_usd_price: u64,
    pub total_tokens_sold: u64,
    pub total_raised: u64,
}

#[event]
pub struct SaleToggled {
    pub sale: Pubkey,
    pub is_paused: bool,
}

#[event]
pub struct SaleEnded {
    pub sale: Pubkey,
    pub tokens_sold: u64,
    pub total_raised: u64,
    pub end_time: i64,
}

#[event]
pub struct TokensWithdrawn {
    pub authority: Pubkey,
    pub amount: u64,
}

#[event]
pub struct SaleParamsUpdated {
    pub sale: Pubkey,
    pub token_price_usd: u64,
    pub max_tokens: u64,
    pub min_purchase: u64,
    pub max_purchase: u64,
    pub max_price_age: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized access")]
    Unauthorized,
    #[msg("Invalid price")]
    InvalidPrice,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Invalid purchase limits")]
    InvalidPurchaseLimit,
    #[msg("Invalid duration")]
    InvalidDuration,
    #[msg("Invalid max age")]
    InvalidMaxAge,
    #[msg("Sale is not active")]
    SaleInactive,
    #[msg("Sale is paused")]
    SalePaused,
    #[msg("Sale is not currently active")]
    SaleNotActive,
    #[msg("Below minimum purchase amount")]
    BelowMinimumPurchase,
    #[msg("Exceeds maximum purchase amount")]
    ExceedsMaximumPurchase,
    #[msg("Exceeds maximum tokens for sale")]
    ExceedsMaxTokens,
    #[msg("Exceeds user purchase limit")]
    ExceedsUserLimit,
    #[msg("Mathematical overflow")]
    MathOverflow,
    #[msg("Sale is still active")]
    SaleStillActive,
    #[msg("Sale has already started")]
    SaleAlreadyStarted,
    #[msg("Invalid token mint")]
    InvalidTokenMint,
    #[msg("Invalid price update account")]
    InvalidPriceUpdate,
    #[msg("Invalid price data from Pyth")]
    InvalidPriceData,
}
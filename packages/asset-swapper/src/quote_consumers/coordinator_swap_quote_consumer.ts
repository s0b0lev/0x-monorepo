import { CoordinatorContract } from '@0x/contract-wrappers';
import { generatePseudoRandomSalt, signatureUtils } from '@0x/order-utils';
import { MarketOperation, RevertReason, SignatureType, SignedZeroExTransaction, ZeroExTransaction } from '@0x/types';
import { Web3Wrapper } from '@0x/web3-wrapper';
import { MethodAbi } from 'ethereum-types';
import { includes } from 'lodash';

import {
    CalldataInfo,
    ExchangeSmartContractParams,
    SmartContractParamsInfo,
    SwapQuote,
    SwapQuoteConsumerError,
    SwapQuoteExecutionOptsBase,
    SwapQuoteGetOutputOptsBase,
} from '../types';
import { assert } from '../utils/assert';
import { swapQuoteConsumerUtils } from '../utils/swap_quote_consumer_utils';
import { utils } from '../utils/utils';

import { ExchangeSwapQuoteConsumer } from './exchange_swap_quote_consumer';

export class CoordinatorSwapQuoteConsumer extends ExchangeSwapQuoteConsumer {
    public async getCalldataOrThrowAsync(
        quote: SwapQuote,
        opts: Partial<SwapQuoteGetOutputOptsBase>,
    ): Promise<CalldataInfo> {
        const signedZeroExTransaction = await this._getCoordinatorZeroExTransactionAsync(quote, opts);
        const { methodAbi, ethAmount } = await this.getSmartContractParamsOrThrowAsync(quote, opts);

        const {
            coordinatorSignatures,
            coordinatorExpirationTimes,
        } = await this._contractWrappers.coordinator.getCoordinatorApprovalsAsync(
            [...quote.orders, ...quote.feeOrders],
            signedZeroExTransaction,
        );

        const coordinator = new CoordinatorContract(
            this._contractWrappers.coordinator.address,
            this._contractWrappers.getProvider(),
        );

        const calldataHexString = coordinator.executeTransaction.getABIEncodedTransactionData(
            signedZeroExTransaction,
            signedZeroExTransaction.signerAddress,
            signedZeroExTransaction.signature,
            coordinatorExpirationTimes,
            coordinatorSignatures,
        );
        return {
            calldataHexString,
            methodAbi,
            toAddress: coordinator.address,
            ethAmount,
        };
    }

    public async getSmartContractParamsOrThrowAsync(
        quote: SwapQuote,
        _opts: Partial<SwapQuoteGetOutputOptsBase>,
    ): Promise<SmartContractParamsInfo<ExchangeSmartContractParams>> {
        assert.isValidSwapQuote('quote', quote);

        const { orders } = quote;

        const signatures = orders.map(o => o.signature);

        const optimizedOrders = swapQuoteConsumerUtils.optimizeOrdersForMarketExchangeOperation(orders, quote.type);

        let params: ExchangeSmartContractParams;
        let methodName: string;

        if (quote.type === MarketOperation.Buy) {
            const { makerAssetFillAmount } = quote;

            params = {
                orders: optimizedOrders,
                signatures,
                makerAssetFillAmount,
                type: MarketOperation.Buy,
            };

            methodName = 'marketBuyOrders';
        } else {
            const { takerAssetFillAmount } = quote;

            params = {
                orders: optimizedOrders,
                signatures,
                takerAssetFillAmount,
                type: MarketOperation.Sell,
            };

            methodName = 'marketSellOrders';
        }

        const methodAbi = utils.getMethodAbiFromContractAbi(
            this._contractWrappers.exchange.abi,
            methodName,
        ) as MethodAbi;

        return {
            params,
            toAddress: this._contractWrappers.exchange.address,
            methodAbi,
        };
    }

    public async executeSwapQuoteOrThrowAsync(
        quote: SwapQuote,
        opts: Partial<SwapQuoteExecutionOptsBase>,
    ): Promise<string> {
        assert.isValidSwapQuote('quote', quote);

        const { takerAddress, gasLimit, gasPrice } = opts;

        if (takerAddress !== undefined) {
            assert.isETHAddressHex('takerAddress', takerAddress);
        }
        if (gasLimit !== undefined) {
            assert.isNumber('gasLimit', gasLimit);
        }
        if (gasPrice !== undefined) {
            assert.isBigNumber('gasPrice', gasPrice);
        }

        try {
            let txHash: string;
            const signedZeroExTransaction = await this._getCoordinatorZeroExTransactionAsync(quote, opts);

            const {
                coordinatorSignatures,
                coordinatorExpirationTimes,
            } = await this._contractWrappers.coordinator.getCoordinatorApprovalsAsync(
                [...quote.orders, ...quote.feeOrders],
                signedZeroExTransaction,
            );
            const coordinator = new CoordinatorContract(
                this._contractWrappers.coordinator.address,
                this._contractWrappers.getProvider(),
            );
            await coordinator.executeTransaction.callAsync(
                signedZeroExTransaction,
                signedZeroExTransaction.signerAddress,
                signedZeroExTransaction.signature,
                coordinatorExpirationTimes,
                coordinatorSignatures,
                { from: signedZeroExTransaction.signerAddress },
            );

            txHash = await coordinator.executeTransaction.sendTransactionAsync(
                signedZeroExTransaction,
                signedZeroExTransaction.signerAddress,
                signedZeroExTransaction.signature,
                coordinatorExpirationTimes,
                coordinatorSignatures,
                { from: signedZeroExTransaction.signerAddress },
            );
            return txHash;
        } catch (err) {
            if (includes(err.message, 'SIGNATURE_REQUEST_DENIED')) {
                throw new Error(SwapQuoteConsumerError.SignatureRequestDenied);
            } else if (includes(err.message, RevertReason.CompleteFillFailed)) {
                throw new Error(SwapQuoteConsumerError.TransactionValueTooLow);
            } else {
                throw err;
            }
        }
    }
    private async _getCoordinatorZeroExTransactionAsync(
        quote: SwapQuote,
        opts: Partial<SwapQuoteGetOutputOptsBase>,
    ): Promise<SignedZeroExTransaction> {
        assert.isValidSwapQuote('quote', quote);
        const takerAddress = opts.takerAddress as string;
        assert.isETHAddressHex('opts.takerAddress', takerAddress);

        const { params } = await this.getSmartContractParamsOrThrowAsync(quote, opts);

        const { orders, signatures } = params;
        let zeroExOperation: string;
        if (params.type === MarketOperation.Buy) {
            const { makerAssetFillAmount } = params;
            zeroExOperation = this._contractWrappers.exchange.marketBuyOrdersNoThrow.getABIEncodedTransactionData(
                orders,
                makerAssetFillAmount,
                signatures,
            );
        } else {
            const { takerAssetFillAmount } = params;
            zeroExOperation = this._contractWrappers.exchange.marketSellOrdersNoThrow.getABIEncodedTransactionData(
                orders,
                takerAssetFillAmount,
                signatures,
            );
        }
        const transaction: ZeroExTransaction = {
            salt: generatePseudoRandomSalt(),
            signerAddress: takerAddress,
            data: zeroExOperation,
            verifyingContractAddress: this._contractWrappers.exchange.address,
        };
        // If the takerAddress is a contract we need to generate a isValidSignature SignatureType and skip
        // the signing via the provider.
        const web3Wrapper = new Web3Wrapper(this._contractWrappers.getProvider());
        const contractCode = await web3Wrapper.getContractCodeAsync(takerAddress);
        if (contractCode === '0x' || contractCode === '0x00') {
            const signedZeroExTransaction = await signatureUtils.ecSignTransactionAsync(
                this.provider,
                transaction,
                takerAddress,
            );
            return signedZeroExTransaction;
        } else {
            /*
                    function isValidSignature(
                            bytes32, // hash
                            bytes calldata // signature
                    )
                        external
                        pure
                        returns (bytes4)
                    {
                        return IS_VALID_WALLET_SIGNATURE_MAGIC_VALUE;
                    }
             */
            const signature = signatureUtils.convertToSignatureWithType('0x00', SignatureType.Wallet);
            return {
                ...transaction,
                signature,
            };
        }
    }
}

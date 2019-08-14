import { CoordinatorContract } from '@0x/contract-wrappers';
import {
    CoordinatorServerApprovalRawResponse,
    CoordinatorServerApprovalResponse,
    CoordinatorServerError,
    CoordinatorServerErrorMsg,
    CoordinatorServerResponse,
} from '@0x/contract-wrappers/lib/src/utils/coordinator_server_types';
import { generatePseudoRandomSalt, signatureUtils } from '@0x/order-utils';
import { MarketOperation, RevertReason, SignedOrder, SignedZeroExTransaction, ZeroExTransaction } from '@0x/types';
import { BigNumber } from '@0x/utils';
import { MethodAbi } from 'ethereum-types';
import { flatten, includes } from 'lodash';

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

        const { coordinatorApprovalSignatures, coordinatorExpirationTimes } = await this._getCoordinatorApprovalsAsync(
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
            coordinatorApprovalSignatures,
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
                coordinatorApprovalSignatures,
                coordinatorExpirationTimes,
            } = await this._getCoordinatorApprovalsAsync(
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
                coordinatorApprovalSignatures,
                { from: signedZeroExTransaction.signerAddress },
            );

            txHash = await coordinator.executeTransaction.sendTransactionAsync(
                signedZeroExTransaction,
                signedZeroExTransaction.signerAddress,
                signedZeroExTransaction.signature,
                coordinatorExpirationTimes,
                coordinatorApprovalSignatures,
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
        const signedZeroExTransaction = await signatureUtils.ecSignTransactionAsync(
            this.provider,
            transaction,
            takerAddress,
        );
        return signedZeroExTransaction;
    }
    private async _getCoordinatorApprovalsAsync(
        signedOrders: SignedOrder[],
        signedZeroExTransaction: SignedZeroExTransaction,
    ): Promise<{
        coordinatorApprovalSignatures: string[];
        coordinatorExpirationTimes: BigNumber[];
        signedZeroExTransaction: SignedZeroExTransaction;
    }> {
        const coordinatorOrders = signedOrders.filter(
            o => o.senderAddress === this._contractWrappers.coordinator.address,
        );
        const serverEndpointsToOrders: { [endpoint: string]: SignedOrder[] } = await (this._contractWrappers
            .coordinator as any)._mapServerEndpointsToOrdersAsync(coordinatorOrders);
        const errorResponses: CoordinatorServerResponse[] = [];
        const approvalResponses: CoordinatorServerResponse[] = [];
        const txOrigin = signedZeroExTransaction.signerAddress;
        for (const endpoint of Object.keys(serverEndpointsToOrders)) {
            const response: CoordinatorServerResponse = await (this._contractWrappers
                .coordinator as any)._executeServerRequestAsync(signedZeroExTransaction, txOrigin, endpoint);
            if (response.isError) {
                errorResponses.push(response);
            } else {
                approvalResponses.push(response);
            }
        }
        function formatRawResponse(
            rawResponse: CoordinatorServerApprovalRawResponse,
        ): CoordinatorServerApprovalResponse {
            return {
                signatures: ([] as string[]).concat(rawResponse.signatures),
                expirationTimeSeconds: ([] as BigNumber[]).concat(
                    Array(rawResponse.signatures.length).fill(rawResponse.expirationTimeSeconds),
                ),
            };
        }
        if (errorResponses.length === 0) {
            // concatenate all approval responses
            const allApprovals = approvalResponses.map(resp =>
                formatRawResponse(resp.body as CoordinatorServerApprovalRawResponse),
            );

            const allSignatures = flatten(allApprovals.map(a => a.signatures));
            const allExpirationTimes = flatten(allApprovals.map(a => a.expirationTimeSeconds));
            return {
                coordinatorApprovalSignatures: allSignatures,
                coordinatorExpirationTimes: allExpirationTimes,
                signedZeroExTransaction,
            };
        } else {
            // format errors and approvals
            // concatenate approvals
            const notCoordinatorOrders = signedOrders.filter(
                o => o.senderAddress !== this._contractWrappers.coordinator.address,
            );
            const approvedOrdersNested = approvalResponses.map(resp => {
                const endpoint = resp.coordinatorOperator;
                const orders = serverEndpointsToOrders[endpoint];
                return orders;
            });
            const approvedOrders = flatten(approvedOrdersNested.concat(notCoordinatorOrders));

            // lookup orders with errors
            const errorsWithOrders = errorResponses.map(resp => {
                const endpoint = resp.coordinatorOperator;
                const orders = serverEndpointsToOrders[endpoint];
                return {
                    ...resp,
                    orders,
                };
            });

            // throw informative error
            const cancellations = new Array();
            throw new CoordinatorServerError(
                CoordinatorServerErrorMsg.FillFailed,
                approvedOrders,
                cancellations,
                errorsWithOrders,
            );
        }
    }
}

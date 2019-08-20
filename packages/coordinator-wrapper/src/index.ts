import { BigNumber } from '@0x/utils';

export { CoordinatorWrapper } from './coordinator_wrapper';

export {
    CoordinatorServerError,
    CoordinatorServerErrorMsg,
    CoordinatorServerCancellationResponse,
} from './server_types';

export interface CoordinatorTransaction {
    salt: BigNumber;
    signerAddress: string;
    data: string;
}

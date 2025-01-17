import type {FormValue} from '@components/Form/types';
import type * as OnyxCommon from '@src/types/onyx/OnyxCommon';

type BaseForm = {
    /** Controls the loading state of the form */
    isLoading?: boolean;

    /** Server side errors keyed by microtime */
    errors?: OnyxCommon.Errors | null;

    /** Field-specific server side errors keyed by microtime */
    errorFields?: OnyxCommon.ErrorFields | null;
};

type FormValues = Record<string, FormValue>;
type Form<TFormValues extends FormValues = FormValues> = TFormValues & BaseForm;

export default Form;
export type {BaseForm};

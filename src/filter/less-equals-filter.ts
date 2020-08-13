/*
 * Copyright (c) 2020 Oracle and/or its affiliates.
 *
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * http://oss.oracle.com/licenses/upl.
 */

import { ValueExtractor } from '../extractor/'
import { ComparisonFilter } from '.'
import { internal } from './package-internal'

/**
 * Filter which compares the result of a method invocation with a value for
 * `"`Less or Equals`"` condition. In a case when either result of a method
 * invocation or a value to compare are equal to null, the evaluate
 * test yields `false`. This approach is equivalent to the way
 * the `NULL` values are handled by SQL.
 *
 * @typeParam T  the type of the input argument to the filter
 * @typeParam E  the type of value to use for comparison
 */
export class LessEqualsFilter<T = any, E = any>
  extends ComparisonFilter<T, E, E> {
  /**
   * Construct a `LessEqualsFilter` for testing `Less or Equals` condition.
   *
   * @param extractor  the ValueExtractor to use by this filter or the name of the method to invoke via reflection
   * @param value      the object to compare the result with
   */
  constructor (extractor: ValueExtractor<T, E> | string, value: E) {
    super(internal.filterName('LessEqualsFilter'), extractor, value)
  }
}

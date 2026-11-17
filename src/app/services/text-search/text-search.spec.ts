import { TestBed } from '@angular/core/testing';
import { TextSearch } from './text-search';

describe('TextSearch', () => {
  let service: TextSearch;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(TextSearch);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});

import { TestBed } from '@angular/core/testing';
import { TextSelect } from './text-select';

describe('TextSelect', () => {
  let service: TextSelect;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(TextSelect);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});

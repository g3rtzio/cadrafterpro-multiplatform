import { TestBed } from '@angular/core/testing';
import { PageLabels } from './page-labels';

describe('PageLabels', () => {
  let service: PageLabels;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PageLabels);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
